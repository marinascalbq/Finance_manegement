import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  GoogleAuthProvider, signInWithPopup, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, addDoc, collection, query, where, getDocs, updateDoc, deleteDoc,
  writeBatch, increment, serverTimestamp, Timestamp, orderBy, limit, startAfter
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ============================================================
// ESTADO GLOBAL
// ============================================================
let usuarioAtual = null;
let contasCache = [];
let categoriasCache = [];
let regrasCache = [];
let historicoUltimoDoc = null;
let historicoFiltrosAtuais = {};
let dashboardPeriodoAtual = { ano: null, mes: null };

// ============================================================
// AUTENTICAÇÃO
// ============================================================
const googleProvider = new GoogleAuthProvider();

async function garantirPersistencia() {
  await setPersistence(auth, browserLocalPersistence);
}

document.getElementById('btn-entrar').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const senha = document.getElementById('login-senha').value;
  const msg = document.getElementById('login-msg');
  msg.className = 'msg'; msg.textContent = 'Entrando…';
  try {
    await garantirPersistencia();
    await signInWithEmailAndPassword(auth, email, senha);
  } catch (e) {
    console.error('Erro no login:', e);
    msg.className = 'msg msg-erro'; msg.textContent = traduzErroAuth(e);
  }
});

document.getElementById('btn-criar-conta').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const senha = document.getElementById('login-senha').value;
  const msg = document.getElementById('login-msg');
  if (senha.length < 6) { msg.className = 'msg msg-erro'; msg.textContent = 'A senha precisa ter pelo menos 6 caracteres.'; return; }
  msg.className = 'msg'; msg.textContent = 'Criando conta…';
  try {
    await garantirPersistencia();
    await createUserWithEmailAndPassword(auth, email, senha);
  } catch (e) {
    console.error('Erro ao criar conta:', e);
    msg.className = 'msg msg-erro'; msg.textContent = traduzErroAuth(e);
  }
});

document.getElementById('btn-google').addEventListener('click', async () => {
  const msg = document.getElementById('login-msg');
  msg.className = 'msg'; msg.textContent = 'Abrindo login do Google…';
  try {
    await garantirPersistencia();
    await signInWithPopup(auth, googleProvider);
  } catch (e) {
    console.error('Erro no login com Google:', e);
    msg.className = 'msg msg-erro'; msg.textContent = traduzErroAuth(e);
  }
});

document.getElementById('btn-sair').addEventListener('click', () => signOut(auth));

function traduzErroAuth(e) {
  const c = e.code || '';
  if (c.includes('email-already-in-use')) return 'Esse e-mail já tem conta. Tente entrar.';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'E-mail ou senha incorretos.';
  if (c.includes('invalid-email')) return 'E-mail inválido.';
  if (c.includes('weak-password')) return 'Senha muito fraca (mínimo 6 caracteres).';
  if (c.includes('popup-closed-by-user')) return 'Login com Google cancelado.';
  if (c.includes('popup-blocked')) return 'O navegador bloqueou o popup do Google. Permita popups para este site.';
  if (c.includes('unauthorized-domain')) return 'Este domínio não está autorizado no Firebase Authentication (Configurações > Domínios autorizados).';
  return 'Erro: ' + (e.message || e);
}

function mensagemAmigavelFirestore(e) {
  const msg = (e && e.message) || String(e);
  if (msg.includes('permission-denied') || msg.includes('Missing or insufficient permissions')) {
    return 'Sem permissão para ler estes dados. Confirme se as regras do Firestore foram publicadas: firebase deploy --only firestore:rules';
  }
  if (msg.includes('index') || msg.includes('requires an index')) {
    return 'Esta consulta precisa de um índice no Firestore. Abra o Console (F12): a mensagem completa traz um link para criar o índice automaticamente. Depois de criar, aguarde 1-2 minutos e tente de novo.';
  }
  return msg;
}

onAuthStateChanged(auth, async (user) => {
  const telaCarregando = document.getElementById('tela-carregando');
  const telaLogin = document.getElementById('tela-login');
  const telaOnboarding = document.getElementById('tela-onboarding');
  const telaApp = document.getElementById('app');

  if (!user) {
    telaCarregando.style.display = 'none';
    telaLogin.style.display = 'flex';
    telaOnboarding.style.display = 'none';
    telaApp.style.display = 'none';
    return;
  }

  try {
    const usuarioRef = doc(db, 'usuarios', user.uid);
    const snap = await getDoc(usuarioRef);

    if (!snap.exists()) {
      telaCarregando.style.display = 'none';
      telaLogin.style.display = 'none';
      telaOnboarding.style.display = 'flex';
      if (user.displayName) document.getElementById('onb-nome').value = user.displayName.split(' ')[0];
      return;
    }

    usuarioAtual = { uid: user.uid, email: user.email, primeiroNome: snap.data().primeiroNome };
    await iniciarApp();
  } catch (e) {
    console.error('Erro ao verificar/iniciar usuário:', e);
    alert('Não foi possível carregar seus dados.\n' + mensagemAmigavelFirestore(e));
    telaCarregando.style.display = 'none';
  }
});

document.getElementById('btn-salvar-nome').addEventListener('click', async () => {
  const nome = document.getElementById('onb-nome').value.trim();
  const msg = document.getElementById('onb-msg');
  if (!nome) { msg.className = 'msg msg-erro'; msg.textContent = 'Digite seu nome.'; return; }
  const user = auth.currentUser;
  const btn = document.getElementById('btn-salvar-nome');
  btn.disabled = true;
  msg.className = 'msg'; msg.textContent = 'Preparando sua conta…';
  try {
    await setDoc(doc(db, 'usuarios', user.uid), {
      userId: user.uid, primeiroNome: nome, email: user.email,
      criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
    });
    await criarDadosPadrao(user.uid);
    usuarioAtual = { uid: user.uid, email: user.email, primeiroNome: nome };
    document.getElementById('tela-onboarding').style.display = 'none';
    await iniciarApp();
  } catch (e) {
    console.error('Erro ao criar conta inicial:', e);
    btn.disabled = false;
    msg.className = 'msg msg-erro'; msg.textContent = 'Erro ao preparar sua conta: ' + (e.message || e);
    alert('Não foi possível concluir o cadastro inicial.\n' + mensagemAmigavelFirestore(e));
  }
});

// ============================================================
// DADOS PADRÃO (primeiro acesso, ou auto-cura de contas travadas)
// ============================================================
async function criarDadosPadrao(uid) {
  const batch = writeBatch(db);

  const contasPadrao = [
    { nome: 'Conta Corrente', tipoConta: 'Corrente', instituicao: '' },
    { nome: 'Cartão de Crédito', tipoConta: 'Cartao', instituicao: '' }
  ];
  contasPadrao.forEach(c => {
    const ref = doc(collection(db, 'contas'));
    batch.set(ref, {
      userId: uid, nome: c.nome, tipoConta: c.tipoConta, instituicao: c.instituicao,
      considerarPatrimonio: 'Sim', ativa: 'Sim', saldoAtual: 0, totalTransacoes: 0, ultimaMovimentacao: null,
      diaFechamentoFatura: null, diaVencimentoFatura: null, contaPagamentoFaturaId: null,
      criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
    });
  });

  const categoriasPadrao = [
    ['Farmacia', 'Despesa'], ['Mercado', 'Despesa'], ['Restaurante', 'Despesa'], ['Transporte', 'Despesa'],
    ['Saude', 'Despesa'], ['Cuidados pessoais', 'Despesa'], ['Lazer', 'Despesa'], ['Presentes', 'Despesa'],
    ['Aplicativos de entrega', 'Despesa'], ['Educacao/Cursos', 'Despesa'], ['Impostos/Juros', 'Despesa'],
    ['Outros', 'Despesa'], ['Investimentos', 'Investimento'], ['Transferencia', 'Transferencia'],
    ['Renda fixa', 'Receita'], ['Renda extra', 'Receita'], ['Sem categoria', 'Despesa']
  ];
  categoriasPadrao.forEach(([nome, tipo]) => {
    const ref = doc(collection(db, 'categorias'));
    batch.set(ref, {
      userId: uid, nome, tipoPadrao: tipo, ativa: 'Sim', observacao: 'Categoria padrão criada automaticamente.',
      criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
    });
  });

  const hoje = new Date();
  const ano = hoje.getFullYear(), mes = hoje.getMonth() + 1;
  batch.set(doc(db, 'dashboard_mensal', chaveMensal(uid, ano, mes)), {
    userId: uid, ano, mes, receitas: 0, despesas: 0, aportes: 0, transferencias: 0, resultado: 0,
    porCategoria: {}, porConta: {}, criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
  }, { merge: true });
  batch.set(doc(db, 'dashboard_anual', chaveAnual(uid, ano)), {
    userId: uid, ano, receitas: 0, despesas: 0, aportes: 0, transferencias: 0, resultado: 0,
    criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
  }, { merge: true });

  await batch.commit();
}

// ============================================================
// INICIALIZAÇÃO DO APP
// ============================================================
async function iniciarApp() {
  try {
    document.getElementById('tela-carregando').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    document.getElementById('saudacao').textContent = 'Olá, ' + usuarioAtual.primeiroNome;

    await carregarContasCategorias();
    await carregarRegras();

    if (contasCache.length === 0 && categoriasCache.length === 0) {
      await criarDadosPadrao(usuarioAtual.uid);
      await carregarContasCategorias();
    }

    preencherSeletoresAno();
    navegarPara('dashboard');
    await carregarDashboard();
  } catch (e) {
    console.error('Erro ao iniciar o app:', e);
    alert('Ocorreu um erro ao carregar o app.\n' + mensagemAmigavelFirestore(e));
    document.getElementById('tela-carregando').style.display = 'none';
  }
}

document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => navegarPara(btn.dataset.tela));
});

function navegarPara(tela) {
  document.querySelectorAll('main > section').forEach(s => s.style.display = 'none');
  document.getElementById('tela-' + tela).style.display = 'block';
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tela === tela));
  if (tela === 'historico' && !historicoUltimoDoc) buscarHistorico(true);
  if (tela === 'investimentos') carregarInvestimentos();
  if (tela === 'anual') carregarAnual();
  if (tela === 'config') renderizarContasCategorias();
}

function fmtMoeda(v) {
  v = v || 0;
  return (v < 0 ? '- ' : '') + 'R$ ' + Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function preencherSeletoresAno() {
  const anoAtual = new Date().getFullYear();
  const anos = [];
  for (let a = anoAtual - 3; a <= anoAtual + 1; a++) anos.push(a);
  ['d_ano', 'a_ano'].forEach(id => {
    const sel = document.getElementById(id);
    sel.innerHTML = anos.map(a => `<option value="${a}" ${a === anoAtual ? 'selected' : ''}>${a}</option>`).join('');
  });
  document.getElementById('d_mes').value = String(new Date().getMonth() + 1);
}

// ============================================================
// CONTAS E CATEGORIAS (cache local)
// ============================================================
async function carregarContasCategorias() {
  const qc = query(collection(db, 'contas'), where('userId', '==', usuarioAtual.uid));
  const qcat = query(collection(db, 'categorias'), where('userId', '==', usuarioAtual.uid));
  const [snapContas, snapCat] = await Promise.all([getDocs(qc), getDocs(qcat)]);
  contasCache = snapContas.docs.map(d => ({ id: d.id, ...d.data() }));
  categoriasCache = snapCat.docs.map(d => ({ id: d.id, ...d.data() }));

  const selConta = document.getElementById('f_conta');
  selConta.innerHTML = contasCache.map(c => `<option value="${c.id}">${c.nome}</option>`).join('');
  const selCat = document.getElementById('f_categoria');
  selCat.innerHTML = categoriasCache.map(c => `<option value="${c.id}">${c.nome}</option>`).join('');

  const hConta = document.getElementById('h_conta');
  hConta.innerHTML = '<option value="">Todas</option>' + contasCache.map(c => `<option value="${c.nome}">${c.nome}</option>`).join('');
  const hCat = document.getElementById('h_categoria');
  hCat.innerHTML = '<option value="">Todas</option>' + categoriasCache.map(c => `<option value="${c.nome}">${c.nome}</option>`).join('');

  const eConta = document.getElementById('e_conta');
  eConta.innerHTML = contasCache.map(c => `<option value="${c.nome}">${c.nome}</option>`).join('');
  const eCat = document.getElementById('e_categoria');
  eCat.innerHTML = categoriasCache.map(c => `<option value="${c.nome}">${c.nome}</option>`).join('');
}

async function carregarRegras() {
  const q = query(collection(db, 'regras_categorizacao'), where('userId', '==', usuarioAtual.uid));
  const snap = await getDocs(q);
  regrasCache = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.prioridade || 0) - (a.prioridade || 0));
}

function renderizarContasCategorias() {
  document.getElementById('tabela-contas').innerHTML = contasCache.map(c => `
    <tr><td>${c.nome}</td><td>${c.tipoConta || ''}</td><td>${c.instituicao || ''}</td></tr>`).join('');
  document.getElementById('tabela-categorias').innerHTML = categoriasCache.map(c => `
    <tr><td>${c.nome}</td><td><span class="tag">${c.tipoPadrao || '(sem tipo)'}</span></td></tr>`).join('');
}

document.getElementById('formConta').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, 'contas'), {
      userId: usuarioAtual.uid,
      nome: document.getElementById('c_nome').value,
      tipoConta: normalizarTipoConta(document.getElementById('c_nome').value, document.getElementById('c_tipo').value),
      instituicao: document.getElementById('c_instituicao').value,
      considerarPatrimonio: 'Sim', ativa: 'Sim', saldoAtual: 0, totalTransacoes: 0, ultimaMovimentacao: null,
      diaFechamentoFatura: null, diaVencimentoFatura: null, contaPagamentoFaturaId: null,
      criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
    });
    e.target.reset();
    await carregarContasCategorias();
    renderizarContasCategorias();
  } catch (err) {
    console.error('Erro ao adicionar conta:', err);
    alert('Não foi possível adicionar a conta.\n' + mensagemAmigavelFirestore(err));
  }
});

document.getElementById('formCategoria').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, 'categorias'), {
      userId: usuarioAtual.uid,
      nome: document.getElementById('cat_nome').value,
      tipoPadrao: document.getElementById('cat_tipo').value,
      ativa: 'Sim', observacao: '',
      criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
    });
    e.target.reset();
    await carregarContasCategorias();
    renderizarContasCategorias();
  } catch (err) {
    console.error('Erro ao adicionar categoria:', err);
    alert('Não foi possível adicionar a categoria.\n' + mensagemAmigavelFirestore(err));
  }
});

// ============================================================
// NORMALIZAÇÃO DE CONTA (tipo pelo nome)
// ============================================================
function normalizarTipoConta(nome, tipoDigitado) {
  const n = (nome || '').toLowerCase();
  if (n.includes('cart')) return 'Cartao';
  if (n.includes('investi')) return 'Investimento';
  if (tipoDigitado && tipoDigitado.trim()) return tipoDigitado.trim();
  return 'Corrente';
}

// ============================================================
// CATEGORIZAÇÃO
// ============================================================
function tipoPadraoPorCategoria(categoriaNome, tipoMovimento) {
  const c = (categoriaNome || '').trim().toLowerCase();
  if (c === 'renda fixa' || c === 'renda extra') return 'Receita';
  if (c === 'transferencia' || c === 'transferência') return 'Transferencia';
  if (c === 'investimentos') return 'Investimento';
  const despesas = ['farmacia', 'mercado', 'restaurante', 'transporte', 'saude', 'cuidados pessoais',
    'lazer', 'presentes', 'aplicativos de entrega', 'educacao/cursos', 'impostos/juros', 'outros'];
  if (despesas.includes(c)) return 'Despesa';
  if (tipoMovimento === 'Receita') return 'Receita';
  if (tipoMovimento === 'Transferência') return 'Transferencia';
  return 'Despesa';
}

const REGRAS_PADRAO = [
  { termos: ['drogasil', 'drogaria', 'raia'], categoria: 'Farmacia' },
  { termos: ['assai', 'mercado', 'hortifruti', 'mix mateus'], categoria: 'Mercado' },
  { termos: ['ifd', 'ifood', 'restaurante', 'bar', 'pizzaria', 'tem jeito', 'chica pitanga'], categoria: 'Restaurante' },
  { termos: ['uber', 'parking', 'mobilidade', 'posto', 'petrocal'], categoria: 'Transporte' },
  { termos: ['claro', 'neoenergia', 'condominio'], categoria: 'Outros' },
  { termos: ['petz', 'petlove'], categoria: 'Outros' },
  { termos: ['wellhub', 'hyrox', 'sympla', 'cinemark'], categoria: 'Lazer' },
  { termos: ['beauty', 'escova', 'loja 4i21', 'renner', 'riachuelo'], categoria: 'Cuidados pessoais' },
  { termos: ['ntt data'], categoria: 'Renda fixa' },
  { termos: ['transf saldo c/sal p/cc'], categoria: 'Renda fixa' },
  { termos: ['remuneracao aplicacao', 'rentab', 'tesouro', 'resgate', 'cdb', 'fundo'], categoria: 'Investimentos' },
  { termos: ['pix enviado', 'pix recebido', 'pagamento fatura', 'gastos cartao de credito'], categoria: 'Transferencia' }
];

function sugerirCategoriaPorDescricao(descricao, contaNome) {
  const texto = (descricao || '').toLowerCase() + ' ' + (contaNome || '').toLowerCase();
  for (const r of regrasCache) {
    if (r.ativa === false || r.ativa === 'Nao') continue;
    if (r.termo && texto.includes(r.termo.toLowerCase())) {
      return { categoria: r.categoriaNome, tipoPadrao: r.tipoPadrao || tipoPadraoPorCategoria(r.categoriaNome), regraId: r.id };
    }
  }
  for (const r of REGRAS_PADRAO) {
    if (r.termos.some(t => texto.includes(t))) {
      return { categoria: r.categoria, tipoPadrao: tipoPadraoPorCategoria(r.categoria), regraId: null };
    }
  }
  return null;
}

// Decide a categoria final de uma transação, respeitando o que veio do CSV.
function normalizarCategoria(categoriaBruta, tipoMovimento, descricao, contaNome) {
  const categoriaOriginal = (categoriaBruta || '').trim();
  const vazio = categoriaOriginal === '';
  const ehOutros = categoriaOriginal.toLowerCase() === 'outros';

  if (!vazio && !ehOutros) {
    return {
      categoriaFinal: categoriaOriginal, categoriaOriginal,
      categoriaSugerida: null, regraCategoriaId: null,
      tipoPadraoCategoria: tipoPadraoPorCategoria(categoriaOriginal, tipoMovimento)
    };
  }

  const sugestao = sugerirCategoriaPorDescricao(descricao, contaNome);

  if (vazio) {
    if (sugestao) {
      return {
        categoriaFinal: sugestao.categoria, categoriaOriginal,
        categoriaSugerida: sugestao.categoria, regraCategoriaId: sugestao.regraId,
        tipoPadraoCategoria: sugestao.tipoPadrao
      };
    }
    return {
      categoriaFinal: 'Sem categoria', categoriaOriginal,
      categoriaSugerida: null, regraCategoriaId: null,
      tipoPadraoCategoria: tipoPadraoPorCategoria('Sem categoria', tipoMovimento)
    };
  }

  // categoria = "Outros": mantem, mas registra sugestao para revisao manual
  return {
    categoriaFinal: 'Outros', categoriaOriginal,
    categoriaSugerida: sugestao ? sugestao.categoria : null,
    regraCategoriaId: sugestao ? sugestao.regraId : null,
    tipoPadraoCategoria: tipoPadraoPorCategoria('Outros', tipoMovimento)
  };
}

async function garantirConta(contaNome) {
  let conta = contasCache.find(c => c.nome.toLowerCase() === contaNome.toLowerCase());
  if (conta) return conta;
  const ref = await addDoc(collection(db, 'contas'), {
    userId: usuarioAtual.uid, nome: contaNome, tipoConta: normalizarTipoConta(contaNome),
    instituicao: '', considerarPatrimonio: 'Sim', ativa: 'Sim', saldoAtual: 0, totalTransacoes: 0,
    ultimaMovimentacao: null, criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
  });
  conta = { id: ref.id, nome: contaNome, saldoAtual: 0, tipoConta: normalizarTipoConta(contaNome) };
  contasCache.push(conta);
  return conta;
}

async function garantirCategoria(categoriaNome, tipoPadraoSugerido) {
  let categoria = categoriasCache.find(c => c.nome.toLowerCase() === categoriaNome.toLowerCase());
  if (categoria) {
    if (!categoria.tipoPadrao && tipoPadraoSugerido) {
      await updateDoc(doc(db, 'categorias', categoria.id), { tipoPadrao: tipoPadraoSugerido, atualizadoEm: serverTimestamp() });
      categoria.tipoPadrao = tipoPadraoSugerido;
    }
    return categoria;
  }
  const ref = await addDoc(collection(db, 'categorias'), {
    userId: usuarioAtual.uid, nome: categoriaNome, tipoPadrao: tipoPadraoSugerido || 'Despesa',
    ativa: 'Sim', observacao: 'Criada automaticamente.',
    criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
  });
  categoria = { id: ref.id, nome: categoriaNome, tipoPadrao: tipoPadraoSugerido || 'Despesa' };
  categoriasCache.push(categoria);
  return categoria;
}

// ============================================================
// CHAVES DE AGREGAÇÃO
// ============================================================
function chaveMensal(uid, ano, mes) { return `${uid}_${ano}_${String(mes).padStart(2, '0')}`; }
function chaveAnual(uid, ano) { return `${uid}_${ano}`; }

function camposAgregados(tipoMovimento, categoriaNome, valor) {
  const campos = {};
  if (tipoMovimento === 'Receita') { campos.receitas = increment(valor); campos.resultado = increment(valor); }
  else if (tipoMovimento === 'Despesa') { campos.despesas = increment(valor); campos.resultado = increment(valor); }
  else if (tipoMovimento === 'Transferência') { campos.transferencias = increment(valor); }
  if (categoriaNome === 'Investimentos') campos.aportes = increment(valor);
  return campos;
}

// ============================================================
// CRIAR TRANSAÇÃO — grava tudo atomicamente
// ============================================================
async function criarTransacao(dados) {
  const d = new Date(dados.data + 'T00:00:00');
  const ano = d.getFullYear(), mes = d.getMonth() + 1;

  const batch = writeBatch(db);
  const txRef = doc(collection(db, 'transacoes'));
  batch.set(txRef, {
    userId: usuarioAtual.uid,
    data: Timestamp.fromDate(d),
    contaId: dados.contaId, contaNome: dados.contaNome,
    categoriaId: dados.categoriaId || null, categoriaNome: dados.categoriaNome,
    categoriaOriginal: dados.categoriaOriginal ?? dados.categoriaNome,
    categoriaSugerida: dados.categoriaSugerida ?? null,
    categoriaAlteradaManual: false,
    regraCategoriaId: dados.regraCategoriaId ?? null,
    descricao: dados.descricao,
    tipoMovimento: dados.tipoMovimento,
    valor: dados.valor,
    fixa: dados.fixa || 'Nao',
    parcela: dados.parcela || null,
    totalParcelas: dados.totalParcelas || null,
    observacao: dados.observacao || '',
    origem: dados.origem || 'manual',
    arquivoOrigem: dados.arquivoOrigem || null,
    hashImportacao: dados.hashImportacao || null,
    chaveDeduplicacao: dados.chaveDeduplicacao || null,
    criadoVia: dados.criadoVia || 'app',
    criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
  });

  if (dados.contaId) {
    batch.set(doc(db, 'contas', dados.contaId), {
      saldoAtual: increment(dados.valor), totalTransacoes: increment(1),
      ultimaMovimentacao: Timestamp.fromDate(d), atualizadoEm: serverTimestamp()
    }, { merge: true });
  }

  const camposMes = camposAgregados(dados.tipoMovimento, dados.categoriaNome, dados.valor);
  batch.set(doc(db, 'dashboard_mensal', chaveMensal(usuarioAtual.uid, ano, mes)),
    { userId: usuarioAtual.uid, ano, mes, ...camposMes, atualizadoEm: serverTimestamp() }, { merge: true });

  const camposAno = camposAgregados(dados.tipoMovimento, dados.categoriaNome, dados.valor);
  batch.set(doc(db, 'dashboard_anual', chaveAnual(usuarioAtual.uid, ano)),
    { userId: usuarioAtual.uid, ano, ...camposAno, atualizadoEm: serverTimestamp() }, { merge: true });

  await batch.commit();
  return txRef.id;
}

async function excluirTransacao(txId) {
  const txRef = doc(db, 'transacoes', txId);
  const snap = await getDoc(txRef);
  if (!snap.exists()) return;
  const t = snap.data();
  const d = t.data.toDate();
  const ano = d.getFullYear(), mes = d.getMonth() + 1;
  const valorReverso = -t.valor;

  const batch = writeBatch(db);
  batch.delete(txRef);
  if (t.contaId) {
    batch.set(doc(db, 'contas', t.contaId), {
      saldoAtual: increment(valorReverso), totalTransacoes: increment(-1), atualizadoEm: serverTimestamp()
    }, { merge: true });
  }
  const camposMes = camposAgregados(t.tipoMovimento, t.categoriaNome, valorReverso);
  batch.set(doc(db, 'dashboard_mensal', chaveMensal(usuarioAtual.uid, ano, mes)), { ...camposMes, atualizadoEm: serverTimestamp() }, { merge: true });
  const camposAno = camposAgregados(t.tipoMovimento, t.categoriaNome, valorReverso);
  batch.set(doc(db, 'dashboard_anual', chaveAnual(usuarioAtual.uid, ano)), { ...camposAno, atualizadoEm: serverTimestamp() }, { merge: true });
  await batch.commit();
}

// Edita Conta/Categoria/TipoMovimento/Observação (não altera Valor nem Data).
async function editarTransacao(txId, novosDados) {
  const txRef = doc(db, 'transacoes', txId);
  const snap = await getDoc(txRef);
  if (!snap.exists()) throw new Error('Lançamento não encontrado.');
  const antigo = snap.data();
  const d = antigo.data.toDate();
  const ano = d.getFullYear(), mes = d.getMonth() + 1;

  const contaMudou = novosDados.contaNome !== antigo.contaNome;
  const novaConta = contaMudou ? await garantirConta(novosDados.contaNome) : null;

  const batch = writeBatch(db);
  batch.update(txRef, {
    contaId: contaMudou ? novaConta.id : antigo.contaId,
    contaNome: novosDados.contaNome,
    categoriaNome: novosDados.categoriaNome,
    categoriaAlteradaManual: true,
    tipoMovimento: novosDados.tipoMovimento,
    observacao: novosDados.observacao || '',
    atualizadoEm: serverTimestamp()
  });

  // reverte a classificacao antiga e aplica a nova como DUAS escritas na mesma ref (permitido em batch)
  const reverso = camposAgregados(antigo.tipoMovimento, antigo.categoriaNome, -antigo.valor);
  const novo = camposAgregados(novosDados.tipoMovimento, novosDados.categoriaNome, antigo.valor);
  const mensalRef = doc(db, 'dashboard_mensal', chaveMensal(usuarioAtual.uid, ano, mes));
  const anualRef = doc(db, 'dashboard_anual', chaveAnual(usuarioAtual.uid, ano));
  batch.set(mensalRef, { ...reverso, atualizadoEm: serverTimestamp() }, { merge: true });
  batch.set(mensalRef, { ...novo, atualizadoEm: serverTimestamp() }, { merge: true });
  batch.set(anualRef, { ...reverso, atualizadoEm: serverTimestamp() }, { merge: true });
  batch.set(anualRef, { ...novo, atualizadoEm: serverTimestamp() }, { merge: true });

  if (contaMudou) {
    batch.set(doc(db, 'contas', antigo.contaId), { saldoAtual: increment(-antigo.valor), totalTransacoes: increment(-1), atualizadoEm: serverTimestamp() }, { merge: true });
    batch.set(doc(db, 'contas', novaConta.id), { saldoAtual: increment(antigo.valor), totalTransacoes: increment(1), atualizadoEm: serverTimestamp() }, { merge: true });
  }

  await batch.commit();

  // opcional: cria regra de categorizacao reutilizavel
  if (novosDados.aplicarSimilares && novosDados.termoRegra) {
    await addDoc(collection(db, 'regras_categorizacao'), {
      userId: usuarioAtual.uid, termo: novosDados.termoRegra.toLowerCase(),
      categoriaNome: novosDados.categoriaNome,
      tipoPadrao: tipoPadraoPorCategoria(novosDados.categoriaNome, novosDados.tipoMovimento),
      prioridade: 10, ativa: true, criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
    });
    await carregarRegras();
  }
}

// ============================================================
// FORMULÁRIO NOVO LANÇAMENTO
// ============================================================
document.getElementById('f_tipo').addEventListener('change', () => {
  document.getElementById('f_saida').checked = (document.getElementById('f_tipo').value === 'Despesa');
});

document.getElementById('formTx').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('form-msg');
  msg.className = 'msg'; msg.textContent = 'Salvando…';
  try {
    const contaId = document.getElementById('f_conta').value;
    const categoriaId = document.getElementById('f_categoria').value;
    const conta = contasCache.find(c => c.id === contaId);
    const categoria = categoriasCache.find(c => c.id === categoriaId);
    let valor = Math.abs(Number(document.getElementById('f_valor').value));
    if (document.getElementById('f_saida').checked) valor = -valor;

    await criarTransacao({
      data: document.getElementById('f_data').value,
      contaId, contaNome: conta ? conta.nome : '',
      categoriaId, categoriaNome: categoria ? categoria.nome : '',
      categoriaOriginal: categoria ? categoria.nome : '',
      descricao: document.getElementById('f_descricao').value,
      tipoMovimento: document.getElementById('f_tipo').value,
      valor,
      fixa: document.getElementById('f_fixa').value,
      observacao: document.getElementById('f_obs').value,
      origem: 'manual', criadoVia: 'app'
    });
    msg.className = 'msg msg-ok'; msg.textContent = '✔ Lançamento salvo!';
    e.target.reset();
    carregarDashboard();
  } catch (err) {
    console.error('Erro ao salvar lançamento:', err);
    msg.className = 'msg msg-erro'; msg.textContent = 'Erro: ' + mensagemAmigavelFirestore(err);
  }
});

// ============================================================
// RECALCULAR SALDOS POR CONTA (varre todas as transações do usuário)
// ============================================================
async function recalcularSaldosPorConta(userId) {
  const q = query(collection(db, 'transacoes'), where('userId', '==', userId));
  const snap = await getDocs(q);

  const grupos = {}; // contaNome -> { soma, total, ultima }
  snap.forEach(docSnap => {
    const t = docSnap.data();
    const nome = t.contaNome || '(sem conta)';
    if (!grupos[nome]) grupos[nome] = { soma: 0, total: 0, ultima: null };
    grupos[nome].soma += Number(t.valor) || 0;
    grupos[nome].total += 1;
    const d = t.data ? t.data.toDate() : null;
    if (d && (!grupos[nome].ultima || d > grupos[nome].ultima)) grupos[nome].ultima = d;
  });

  const nomes = Object.keys(grupos);
  let contasCriadas = 0;
  const lotes = [];
  let batch = writeBatch(db);
  let ops = 0;

  for (const nome of nomes) {
    let conta = contasCache.find(c => c.nome.toLowerCase() === nome.toLowerCase());
    let contaId;
    if (!conta) {
      const ref = doc(collection(db, 'contas'));
      contaId = ref.id;
      batch.set(ref, {
        userId, nome, tipoConta: normalizarTipoConta(nome), instituicao: '',
        considerarPatrimonio: 'Sim', ativa: 'Sim',
        saldoAtual: grupos[nome].soma, totalTransacoes: grupos[nome].total,
        ultimaMovimentacao: grupos[nome].ultima ? Timestamp.fromDate(grupos[nome].ultima) : null,
        criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
      });
      contasCriadas++;
      conta = { id: contaId, nome, saldoAtual: grupos[nome].soma, tipoConta: normalizarTipoConta(nome) };
      contasCache.push(conta);
    } else {
      contaId = conta.id;
      batch.set(doc(db, 'contas', contaId), {
        tipoConta: normalizarTipoConta(nome),
        saldoAtual: grupos[nome].soma, totalTransacoes: grupos[nome].total,
        ultimaMovimentacao: grupos[nome].ultima ? Timestamp.fromDate(grupos[nome].ultima) : null,
        atualizadoEm: serverTimestamp()
      }, { merge: true });
      conta.saldoAtual = grupos[nome].soma;
    }
    ops++;
    if (ops >= 400) { lotes.push(batch); batch = writeBatch(db); ops = 0; }
  }
  lotes.push(batch);
  for (const b of lotes) await b.commit();

  return { contasProcessadas: nomes.length, contasCriadas };
}

// ============================================================
// RECONSTRUIR DASHBOARDS (mensal e anual) — recalcula do zero a partir das transações
// ============================================================
async function reconstruirDashboards(userId) {
  const q = query(collection(db, 'transacoes'), where('userId', '==', userId));
  const snap = await getDocs(q);

  const meses = {}; // "ano_mes" -> {ano,mes,receitas,despesas,aportes,transferencias,resultado,porCategoria,porConta}
  snap.forEach(docSnap => {
    const t = docSnap.data();
    if (!t.data) return;
    const d = t.data.toDate();
    const ano = d.getFullYear(), mes = d.getMonth() + 1;
    const chave = `${ano}_${mes}`;
    if (!meses[chave]) meses[chave] = { ano, mes, receitas: 0, despesas: 0, aportes: 0, transferencias: 0, resultado: 0, porCategoria: {}, porConta: {} };
    const m = meses[chave];
    const valor = Number(t.valor) || 0;

    if (t.tipoMovimento === 'Receita') { m.receitas += valor; m.resultado += valor; }
    else if (t.tipoMovimento === 'Despesa') {
      m.despesas += valor; m.resultado += valor;
      m.porCategoria[t.categoriaNome || 'Sem categoria'] = (m.porCategoria[t.categoriaNome || 'Sem categoria'] || 0) + Math.abs(valor);
    } else if (t.tipoMovimento === 'Transferência') { m.transferencias += valor; }
    if (t.categoriaNome === 'Investimentos') m.aportes += valor;
    m.porConta[t.contaNome || '(sem conta)'] = (m.porConta[t.contaNome || '(sem conta)'] || 0) + valor;
  });

  const anos = {}; // ano -> agregados
  let batch = writeBatch(db);
  let ops = 0;
  const lotes = [];

  for (const chave of Object.keys(meses)) {
    const m = meses[chave];
    batch.set(doc(db, 'dashboard_mensal', chaveMensal(userId, m.ano, m.mes)), {
      userId, ano: m.ano, mes: m.mes, receitas: m.receitas, despesas: m.despesas,
      aportes: m.aportes, transferencias: m.transferencias, resultado: m.resultado,
      porCategoria: m.porCategoria, porConta: m.porConta, atualizadoEm: serverTimestamp()
    }, { merge: false });
    ops++;
    if (ops >= 400) { lotes.push(batch); batch = writeBatch(db); ops = 0; }

    if (!anos[m.ano]) anos[m.ano] = { receitas: 0, despesas: 0, aportes: 0, transferencias: 0, resultado: 0 };
    anos[m.ano].receitas += m.receitas; anos[m.ano].despesas += m.despesas;
    anos[m.ano].aportes += m.aportes; anos[m.ano].transferencias += m.transferencias;
    anos[m.ano].resultado += m.resultado;
  }

  for (const ano of Object.keys(anos)) {
    batch.set(doc(db, 'dashboard_anual', chaveAnual(userId, ano)), {
      userId, ano: Number(ano), ...anos[ano], atualizadoEm: serverTimestamp()
    }, { merge: false });
    ops++;
    if (ops >= 400) { lotes.push(batch); batch = writeBatch(db); ops = 0; }
  }
  lotes.push(batch);
  for (const b of lotes) await b.commit();

  return { mesesRecriados: Object.keys(meses).length, anosRecriados: Object.keys(anos).length };
}

// ============================================================
// RECONSTRUIR BASE DO USUÁRIO (função mestre)
// ============================================================
async function reconstruirBaseDoUsuario(userId) {
  const resumo = { totalTransacoes: 0, contasCriadas: 0, categoriasCriadas: 0, categoriasCorrigidas: 0, dashboardsRecriados: 0, erros: [] };

  try {
    const q = query(collection(db, 'transacoes'), where('userId', '==', userId));
    const snap = await getDocs(q);
    resumo.totalTransacoes = snap.size;

    // categorias faltantes / sem tipoPadrao
    const categoriasVistas = new Set();
    for (const docSnap of snap.docs) {
      const t = docSnap.data();
      const nomeCat = t.categoriaNome || 'Sem categoria';
      if (categoriasVistas.has(nomeCat)) continue;
      categoriasVistas.add(nomeCat);
      const existia = categoriasCache.find(c => c.nome.toLowerCase() === nomeCat.toLowerCase());
      const tipoSugerido = tipoPadraoPorCategoria(nomeCat, t.tipoMovimento);
      if (!existia) { await garantirCategoria(nomeCat, tipoSugerido); resumo.categoriasCriadas++; }
      else if (!existia.tipoPadrao) { await garantirCategoria(nomeCat, tipoSugerido); resumo.categoriasCorrigidas++; }
    }

    const saldos = await recalcularSaldosPorConta(userId);
    resumo.contasCriadas = saldos.contasCriadas;

    const dash = await reconstruirDashboards(userId);
    resumo.dashboardsRecriados = dash.mesesRecriados + dash.anosRecriados;

    await carregarContasCategorias();
  } catch (e) {
    console.error('Erro na reconstrução da base:', e);
    resumo.erros.push(e.message || String(e));
  }

  return resumo;
}

document.getElementById('btn-abrir-rebuild').addEventListener('click', () => {
  document.getElementById('modal-rebuild').style.display = 'flex';
  document.getElementById('rebuild-status').className = 'msg';
  document.getElementById('rebuild-status').textContent = '';
});
document.getElementById('btn-fechar-modal-rebuild').addEventListener('click', () => {
  document.getElementById('modal-rebuild').style.display = 'none';
});
document.getElementById('btn-confirmar-rebuild').addEventListener('click', async () => {
  const status = document.getElementById('rebuild-status');
  status.className = 'msg'; status.textContent = 'Reconstruindo… isso pode levar até 1 minuto.';
  try {
    const r = await reconstruirBaseDoUsuario(usuarioAtual.uid);
    status.className = 'msg msg-ok';
    status.innerHTML = `Concluído: ${r.totalTransacoes} transações processadas, ${r.contasCriadas} contas criadas, `
      + `${r.categoriasCriadas} categorias criadas, ${r.categoriasCorrigidas} categorias corrigidas, `
      + `${r.dashboardsRecriados} dashboards recriados` + (r.erros.length ? `, ${r.erros.length} erro(s): ${r.erros.join('; ')}` : '.');
    renderizarContasCategorias();
    carregarDashboard();
  } catch (e) {
    console.error('Erro ao reconstruir base:', e);
    status.className = 'msg msg-erro';
    status.textContent = 'Erro: ' + mensagemAmigavelFirestore(e);
  }
});

// ============================================================
// DASHBOARD
// ============================================================
document.getElementById('btn-atualizar-dash').addEventListener('click', carregarDashboard);

async function carregarDashboard() {
  document.getElementById('dash-loading').style.display = 'block';
  document.getElementById('dash-conteudo').style.display = 'none';

  try {
    const ano = Number(document.getElementById('d_ano').value);
    const mes = document.getElementById('d_mes').value;
    dashboardPeriodoAtual = { ano, mes: mes ? Number(mes) : null };

    let dados;
    if (mes) {
      const snap = await getDoc(doc(db, 'dashboard_mensal', chaveMensal(usuarioAtual.uid, ano, Number(mes))));
      dados = snap.exists() ? snap.data() : {};
    } else {
      const snap = await getDoc(doc(db, 'dashboard_anual', chaveAnual(usuarioAtual.uid, ano)));
      dados = snap.exists() ? snap.data() : {};
    }
    dados = { receitas: 0, despesas: 0, aportes: 0, transferencias: 0, resultado: 0, porCategoria: {}, ...dados };

    document.getElementById('dash-cards').innerHTML = `
      <div class="card ${dados.resultado >= 0 ? 'pos' : 'neg'}"><div class="label">Resultado</div><div class="valor">${fmtMoeda(dados.resultado)}</div></div>
      <div class="card pos"><div class="label">Receitas</div><div class="valor">${fmtMoeda(dados.receitas)}</div></div>
      <div class="card neg"><div class="label">Despesas</div><div class="valor">${fmtMoeda(Math.abs(dados.despesas))}</div></div>
      <div class="card neutro"><div class="label">Transferências</div><div class="valor">${fmtMoeda(dados.transferencias)}</div></div>
      <div class="card neutro"><div class="label">Aportes</div><div class="valor">${fmtMoeda(Math.abs(dados.aportes))}</div></div>
    `;

    let categoriasOrdenadas;
    if (dados.porCategoria && Object.keys(dados.porCategoria).length) {
      categoriasOrdenadas = Object.entries(dados.porCategoria).sort((a, b) => b[1] - a[1]).slice(0, 8);
    } else {
      const { inicio, fim } = periodoParaIntervalo(ano, mes);
      const qDespesas = query(collection(db, 'transacoes'),
        where('userId', '==', usuarioAtual.uid), where('tipoMovimento', '==', 'Despesa'),
        where('data', '>=', Timestamp.fromDate(inicio)), where('data', '<=', Timestamp.fromDate(fim)));
      const snapDesp = await getDocs(qDespesas);
      const porCategoria = {};
      snapDesp.forEach(d => { const t = d.data(); porCategoria[t.categoriaNome] = (porCategoria[t.categoriaNome] || 0) + Math.abs(t.valor); });
      categoriasOrdenadas = Object.entries(porCategoria).sort((a, b) => b[1] - a[1]).slice(0, 8);
    }

    if (window._chartCat) window._chartCat.destroy();
    window._chartCat = new Chart(document.getElementById('graficoCategoria'), {
      type: 'bar',
      data: { labels: categoriasOrdenadas.map(c => c[0]), datasets: [{ data: categoriasOrdenadas.map(c => c[1]), backgroundColor: '#6E2C3B', borderRadius: 6 }] },
      options: {
        indexAxis: 'y', responsive: true, plugins: { legend: { display: false } },
        onClick: (evt, elems) => {
          if (!elems.length) return;
          const nome = categoriasOrdenadas[elems[0].index][0];
          const { inicio, fim } = periodoParaIntervalo(ano, mes);
          abrirDetalhesTransacoes({ categoriaNome: nome, dataInicial: inicio, dataFinal: fim });
        }
      }
    });

    document.getElementById('tabela-saldos').innerHTML = contasCache.map(c => `
      <tr class="clicavel" data-conta="${c.nome}">
        <td>${c.nome}</td><td class="num ${((c.saldoAtual || 0) < 0) ? 'valor-neg' : 'valor-pos'}">${fmtMoeda(c.saldoAtual || 0)}</td>
      </tr>`).join('');
    document.querySelectorAll('#tabela-saldos tr[data-conta]').forEach(tr => {
      tr.addEventListener('click', () => abrirDetalhesTransacoes({ contaNome: tr.dataset.conta }));
    });

    document.getElementById('dash-loading').style.display = 'none';
    document.getElementById('dash-conteudo').style.display = 'block';
  } catch (e) {
    console.error('Erro ao carregar o dashboard:', e);
    alert('Não foi possível carregar o dashboard.\n' + mensagemAmigavelFirestore(e));
    document.getElementById('dash-loading').style.display = 'none';
    document.getElementById('dash-conteudo').style.display = 'block';
  }
}

function periodoParaIntervalo(ano, mes) {
  if (mes) return { inicio: new Date(ano, Number(mes) - 1, 1), fim: new Date(ano, Number(mes), 0, 23, 59, 59) };
  return { inicio: new Date(ano, 0, 1), fim: new Date(ano, 11, 31, 23, 59, 59) };
}

// ============================================================
// HISTÓRICO — com filtros (data, conta, categoria, tipo) e paginação
// ============================================================
document.getElementById('btn-buscar-historico').addEventListener('click', () => buscarHistorico(true));
document.getElementById('btn-limpar-historico').addEventListener('click', () => {
  document.getElementById('h_data_ini').value = '';
  document.getElementById('h_data_fim').value = '';
  document.getElementById('h_conta').value = '';
  document.getElementById('h_categoria').value = '';
  document.getElementById('h_tipo').value = '';
  buscarHistorico(true);
});
document.getElementById('btn-carregar-mais').addEventListener('click', () => buscarHistorico(false));

// usado pelo drill-down: pre-preenche os filtros e forca nova busca
function abrirDetalhesTransacoes(filtros) {
  document.getElementById('h_data_ini').value = filtros.dataInicial ? toISODate(filtros.dataInicial) : '';
  document.getElementById('h_data_fim').value = filtros.dataFinal ? toISODate(filtros.dataFinal) : '';
  document.getElementById('h_conta').value = filtros.contaNome || '';
  document.getElementById('h_categoria').value = filtros.categoriaNome || '';
  document.getElementById('h_tipo').value = filtros.tipoMovimento || '';
  navegarPara('historico');
  buscarHistorico(true);
}

function toISODate(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

async function buscarHistorico(reiniciar) {
  const info = document.getElementById('historico-info');
  const btnMais = document.getElementById('btn-carregar-mais');
  try {
    if (reiniciar) { historicoUltimoDoc = null; document.getElementById('tabela-historico').innerHTML = ''; }

    const dataIni = document.getElementById('h_data_ini').value;
    const dataFim = document.getElementById('h_data_fim').value;
    const contaNome = document.getElementById('h_conta').value;
    const categoriaNome = document.getElementById('h_categoria').value;
    const tipoMovimento = document.getElementById('h_tipo').value;

    const condicoes = [where('userId', '==', usuarioAtual.uid)];
    if (contaNome) condicoes.push(where('contaNome', '==', contaNome));
    if (categoriaNome) condicoes.push(where('categoriaNome', '==', categoriaNome));
    if (tipoMovimento) condicoes.push(where('tipoMovimento', '==', tipoMovimento));
    if (dataIni) condicoes.push(where('data', '>=', Timestamp.fromDate(new Date(dataIni + 'T00:00:00'))));
    if (dataFim) condicoes.push(where('data', '<=', Timestamp.fromDate(new Date(dataFim + 'T23:59:59'))));

    let qArgs = [collection(db, 'transacoes'), ...condicoes, orderBy('data', 'desc'), limit(50)];
    if (!reiniciar && historicoUltimoDoc) qArgs.splice(qArgs.length - 1, 0, startAfter(historicoUltimoDoc));
    const q = query(...qArgs);
    const snap = await getDocs(q);

    historicoUltimoDoc = snap.docs.length ? snap.docs[snap.docs.length - 1] : historicoUltimoDoc;
    btnMais.style.display = snap.docs.length === 50 ? 'block' : 'none';

    const linhasHtml = snap.docs.map(d => {
      const t = d.data();
      const dataFmt = t.data.toDate().toLocaleDateString('pt-BR');
      return `<tr>
        <td>${dataFmt}</td><td><span class="tag">${t.contaNome}</span></td><td>${t.descricao}</td><td>${t.categoriaNome}</td>
        <td class="num ${t.valor < 0 ? 'valor-neg' : 'valor-pos'}">${fmtMoeda(t.valor)}</td>
        <td><button class="btn-editar" data-id="${d.id}">editar</button> · <button class="btn-excluir" data-id="${d.id}">excluir</button></td>
      </tr>`;
    }).join('');

    if (reiniciar) document.getElementById('tabela-historico').innerHTML = linhasHtml;
    else document.getElementById('tabela-historico').insertAdjacentHTML('beforeend', linhasHtml);

    info.textContent = snap.empty && reiniciar ? 'Nenhum lançamento encontrado para esses filtros.' : '';

    document.querySelectorAll('.btn-excluir').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm('Excluir este lançamento? Os totais serão ajustados automaticamente.')) return;
        try { await excluirTransacao(btn.dataset.id); buscarHistorico(true); carregarDashboard(); }
        catch (e) { console.error(e); alert('Não foi possível excluir.\n' + mensagemAmigavelFirestore(e)); }
      };
    });
    document.querySelectorAll('.btn-editar').forEach(btn => {
      btn.onclick = () => abrirModalEditar(btn.dataset.id);
    });
  } catch (e) {
    console.error('Erro ao buscar histórico:', e);
    info.textContent = '';
    alert('Não foi possível carregar o histórico.\n' + mensagemAmigavelFirestore(e));
  }
}

// ------------------------------------------------------------
// EDIÇÃO MANUAL (modal)
// ------------------------------------------------------------
let transacaoEmEdicaoId = null;

async function abrirModalEditar(txId) {
  try {
    const snap = await getDoc(doc(db, 'transacoes', txId));
    if (!snap.exists()) return;
    const t = snap.data();
    transacaoEmEdicaoId = txId;
    document.getElementById('modal-editar-desc').textContent = `${t.descricao} — ${fmtMoeda(t.valor)}`;
    document.getElementById('e_conta').value = t.contaNome;
    document.getElementById('e_categoria').value = t.categoriaNome;
    document.getElementById('e_tipo').value = t.tipoMovimento;
    document.getElementById('e_obs').value = t.observacao || '';
    document.getElementById('e_aplicar_similares').checked = false;
    document.getElementById('e_termo_wrap').style.display = 'none';
    document.getElementById('e_termo').value = '';
    document.getElementById('modal-editar-msg').textContent = '';
    document.getElementById('modal-editar').style.display = 'flex';
  } catch (e) {
    console.error('Erro ao abrir edição:', e);
    alert('Não foi possível abrir o lançamento.\n' + mensagemAmigavelFirestore(e));
  }
}
document.getElementById('btn-fechar-modal-editar').addEventListener('click', () => {
  document.getElementById('modal-editar').style.display = 'none';
});
document.getElementById('e_aplicar_similares').addEventListener('change', (e) => {
  document.getElementById('e_termo_wrap').style.display = e.target.checked ? 'block' : 'none';
});

document.getElementById('formEditar').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('modal-editar-msg');
  msg.className = 'msg'; msg.textContent = 'Salvando…';
  try {
    await editarTransacao(transacaoEmEdicaoId, {
      contaNome: document.getElementById('e_conta').value,
      categoriaNome: document.getElementById('e_categoria').value,
      tipoMovimento: document.getElementById('e_tipo').value,
      observacao: document.getElementById('e_obs').value,
      aplicarSimilares: document.getElementById('e_aplicar_similares').checked,
      termoRegra: document.getElementById('e_termo').value.trim()
    });
    msg.className = 'msg msg-ok'; msg.textContent = '✔ Atualizado!';
    setTimeout(() => { document.getElementById('modal-editar').style.display = 'none'; }, 600);
    buscarHistorico(true);
    carregarDashboard();
  } catch (err) {
    console.error('Erro ao editar:', err);
    msg.className = 'msg msg-erro'; msg.textContent = 'Erro: ' + mensagemAmigavelFirestore(err);
  }
});

// ============================================================
// INVESTIMENTOS
// ============================================================
document.getElementById('formInvest').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, 'investimentos'), {
      userId: usuarioAtual.uid,
      produto: document.getElementById('i_produto').value,
      categoria: document.getElementById('i_categoria').value,
      instituicao: document.getElementById('i_instituicao').value,
      valorAtual: Number(document.getElementById('i_valor').value),
      rentabilidade: Number(document.getElementById('i_rent').value) || 0,
      dataExtrato: serverTimestamp(), vencimento: null, ativo: 'Sim', observacao: '',
      criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
    });
    e.target.reset();
    carregarInvestimentos();
  } catch (err) {
    console.error('Erro ao adicionar investimento:', err);
    alert('Não foi possível adicionar a posição.\n' + mensagemAmigavelFirestore(err));
  }
});

async function carregarInvestimentos() {
  try {
    const q = query(collection(db, 'investimentos'), where('userId', '==', usuarioAtual.uid));
    const snap = await getDocs(q);
    let total = 0;
    const linhas = snap.docs.map(d => {
      const p = d.data();
      total += Number(p.valorAtual) || 0;
      return `<tr><td>${p.produto}</td><td><span class="tag">${p.categoria}</span></td>
        <td class="num">${fmtMoeda(p.valorAtual)}</td>
        <td class="num ${p.rentabilidade < 0 ? 'valor-neg' : 'valor-pos'}">${fmtMoeda(p.rentabilidade)}</td></tr>`;
    }).join('');
    document.getElementById('tabela-investimentos').innerHTML = linhas;
    document.getElementById('invest-cards').innerHTML = `
      <div class="card pos"><div class="label">Patrimônio total</div><div class="valor">${fmtMoeda(total)}</div></div>
      <div class="card neutro"><div class="label">Posições ativas</div><div class="valor">${snap.size}</div></div>`;
  } catch (e) {
    console.error('Erro ao carregar investimentos:', e);
    alert('Não foi possível carregar os investimentos.\n' + mensagemAmigavelFirestore(e));
  }
}

// ============================================================
// ANUAL
// ============================================================
document.getElementById('btn-atualizar-anual').addEventListener('click', carregarAnual);

async function carregarAnual() {
  try {
    const ano = Number(document.getElementById('a_ano').value || new Date().getFullYear());
    const q = query(collection(db, 'dashboard_mensal'), where('userId', '==', usuarioAtual.uid), where('ano', '==', ano));
    const snap = await getDocs(q);
    const porMes = {};
    for (let m = 1; m <= 12; m++) porMes[m] = { receitas: 0, despesas: 0 };
    snap.forEach(d => { const v = d.data(); porMes[v.mes] = { receitas: v.receitas || 0, despesas: v.despesas || 0 }; });

    const anualSnap = await getDoc(doc(db, 'dashboard_anual', chaveAnual(usuarioAtual.uid, ano)));
    const totais = { receitas: 0, despesas: 0, aportes: 0, resultado: 0, ...(anualSnap.exists() ? anualSnap.data() : {}) };

    document.getElementById('anual-cards').innerHTML = `
      <div class="card pos"><div class="label">Receitas no ano</div><div class="valor">${fmtMoeda(totais.receitas)}</div></div>
      <div class="card neg"><div class="label">Despesas no ano</div><div class="valor">${fmtMoeda(Math.abs(totais.despesas))}</div></div>
      <div class="card ${totais.resultado >= 0 ? 'pos' : 'neg'}"><div class="label">Resultado</div><div class="valor">${fmtMoeda(totais.resultado)}</div></div>
      <div class="card neutro"><div class="label">Aportes</div><div class="valor">${fmtMoeda(Math.abs(totais.aportes || 0))}</div></div>`;

    const nomesMeses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    if (window._chartAnual) window._chartAnual.destroy();
    window._chartAnual = new Chart(document.getElementById('graficoAnual'), {
      type: 'bar',
      data: {
        labels: nomesMeses,
        datasets: [
          { label: 'Receitas', data: nomesMeses.map((_, i) => porMes[i + 1].receitas), backgroundColor: '#8A9A7E', borderRadius: 6 },
          { label: 'Despesas', data: nomesMeses.map((_, i) => Math.abs(porMes[i + 1].despesas)), backgroundColor: '#C67B5C', borderRadius: 6 }
        ]
      },
      options: {
        responsive: true, plugins: { legend: { position: 'bottom' } },
        onClick: (evt, elems) => {
          if (!elems.length) return;
          const mesIndex = elems[0].index + 1;
          const { inicio, fim } = periodoParaIntervalo(ano, mesIndex);
          abrirDetalhesTransacoes({ dataInicial: inicio, dataFinal: fim });
        }
      }
    });
  } catch (e) {
    console.error('Erro ao carregar demonstrativo anual:', e);
    alert('Não foi possível carregar o anual.\n' + mensagemAmigavelFirestore(e));
  }
}

// ============================================================
// IMPORTAÇÃO DE CSV
// ============================================================
document.getElementById('btn-importar-csv').addEventListener('click', () => {
  const file = document.getElementById('csv-file').files[0];
  const progresso = document.getElementById('csv-progresso');
  const erroLista = document.getElementById('csv-erros');
  if (erroLista) erroLista.innerHTML = '';
  if (!file) { progresso.className = 'msg msg-erro'; progresso.textContent = 'Escolha um arquivo CSV primeiro.'; return; }

  Papa.parse(file, {
    header: true,
    skipEmptyLines: 'greedy',
    delimiter: '',
    transformHeader: (h) => h.trim(),
    complete: async (results) => {
      progresso.className = 'msg'; progresso.textContent = `Processando ${results.data.length} linhas…`;
      let importadas = 0, ignoradas = 0, erros = 0;
      const errosDetalhe = [];

      try {
        let numeroLinha = 1;
        for (const linha of results.data) {
          numeroLinha++;
          try {
            const valores = Object.values(linha).map(v => (v || '').toString().trim());
            if (valores.every(v => v === '')) continue;

            const dataStr = converterDataCsv(linha.Data);
            if (!dataStr) { erros++; errosDetalhe.push({ numeroLinha, motivo: `Data inválida ("${linha.Data || ''}"). Use DD/MM/AAAA.` }); continue; }
            const contaNome = (linha.Conta || '').trim();
            const descricao = (linha.Descricao || '').trim();
            if (!contaNome) { erros++; errosDetalhe.push({ numeroLinha, motivo: 'Coluna Conta está vazia.' }); continue; }
            if (!descricao) { erros++; errosDetalhe.push({ numeroLinha, motivo: 'Coluna Descricao está vazia.' }); continue; }

            const valor = converterValorMonetarioBR(linha.Valor);
            if (valor === null) { erros++; errosDetalhe.push({ numeroLinha, motivo: `Valor não reconhecido ("${linha.Valor || ''}").` }); continue; }

            const chave = `${dataStr}|${contaNome}|${descricao}|${valor}`;
            const qDup = query(collection(db, 'transacoes'), where('userId', '==', usuarioAtual.uid), where('chaveDeduplicacao', '==', chave), limit(1));
            const dup = await getDocs(qDup);
            if (!dup.empty) { ignoradas++; continue; }

            const tipoMovimentoCsv = (linha.TipoMovimento || '').trim() || (valor < 0 ? 'Despesa' : 'Receita');
            const norm = normalizarCategoria(linha.Categoria, tipoMovimentoCsv, descricao, contaNome);

            const conta = await garantirConta(contaNome);
            const categoria = await garantirCategoria(norm.categoriaFinal, norm.tipoPadraoCategoria);

            await criarTransacao({
              data: dataStr, contaId: conta.id, contaNome: conta.nome,
              categoriaId: categoria.id, categoriaNome: norm.categoriaFinal,
              categoriaOriginal: norm.categoriaOriginal, categoriaSugerida: norm.categoriaSugerida,
              regraCategoriaId: norm.regraCategoriaId,
              descricao, tipoMovimento: tipoMovimentoCsv,
              valor, fixa: linha.Fixa || 'Nao',
              parcela: linha.Parcela || null, totalParcelas: linha.TotalParcelas || null,
              observacao: linha.Observacao || '', origem: 'csv', arquivoOrigem: file.name,
              chaveDeduplicacao: chave, criadoVia: 'importacao_csv'
            });
            importadas++;
          } catch (err) {
            erros++; errosDetalhe.push({ numeroLinha, motivo: err.message || String(err) });
          }
          if ((importadas + ignoradas + erros) % 10 === 0) {
            progresso.textContent = `Processando… ${importadas} importadas, ${ignoradas} já existiam, ${erros} com erro.`;
          }
        }

        progresso.className = 'msg'; progresso.textContent = 'Ajustando saldos e dashboards…';
        await recalcularSaldosPorConta(usuarioAtual.uid);
        await reconstruirDashboards(usuarioAtual.uid);
        await carregarContasCategorias();

        progresso.className = 'msg msg-ok';
        progresso.textContent = `Concluído: ${importadas} importadas, ${ignoradas} já existiam (ignoradas), ${erros} com erro. Saldos e dashboards atualizados.`;
        exibirErrosCsv(errosDetalhe);
        carregarDashboard();
      } catch (e) {
        console.error('Erro geral na importação do CSV:', e);
        progresso.className = 'msg msg-erro';
        progresso.textContent = 'Erro na importação: ' + mensagemAmigavelFirestore(e);
        alert('A importação foi interrompida por um erro.\n' + mensagemAmigavelFirestore(e));
      }
    },
    error: (err) => {
      console.error('Erro ao ler o CSV:', err);
      progresso.className = 'msg msg-erro';
      progresso.textContent = 'Não foi possível ler o arquivo: ' + (err.message || err);
    }
  });
});

function exibirErrosCsv(lista) {
  const container = document.getElementById('csv-erros');
  if (!container) return;
  if (lista.length === 0) { container.innerHTML = ''; return; }
  const primeiras = lista.slice(0, 10);
  container.innerHTML = `
    <div class="msg msg-erro" style="margin-top:10px;">
      <b>${lista.length} linha(s) com erro${lista.length > 10 ? ' (mostrando as 10 primeiras)' : ''}:</b>
      <ul style="margin:8px 0 0; padding-left:18px;">
        ${primeiras.map(e => `<li>Linha ${e.numeroLinha}: ${e.motivo}</li>`).join('')}
      </ul>
    </div>`;
}

function converterValorMonetarioBR(bruto) {
  if (bruto === null || bruto === undefined) return null;
  let s = String(bruto).trim();
  if (s === '') return null;
  let negativo = false;
  if (/^\(.*\)$/.test(s)) { negativo = true; s = s.slice(1, -1).trim(); }
  s = s.replace(/[^\d,.\-]/g, '');
  if (s === '') return null;
  if (s.startsWith('-')) { negativo = true; s = s.slice(1); }
  const temPonto = s.includes('.');
  const temVirgula = s.includes(',');
  if (temPonto && temVirgula) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) { s = s.replace(/\./g, '').replace(',', '.'); }
    else { s = s.replace(/,/g, ''); }
  } else if (temVirgula) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (temPonto) {
    const casas = s.length - s.lastIndexOf('.') - 1;
    if (casas === 3) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (isNaN(n)) return null;
  return negativo ? -Math.abs(n) : n;
}

function converterDataCsv(valor) {
  if (!valor) return null;
  const partes = String(valor).trim().split('/');
  if (partes.length !== 3) return null;
  const [dd, mm, yyyy] = partes;
  if (!dd || !mm || !yyyy) return null;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

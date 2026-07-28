import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  GoogleAuthProvider, signInWithPopup, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, addDoc, collection, query, where, getDocs, updateDoc, deleteDoc,
  writeBatch, increment, serverTimestamp, Timestamp, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ============================================================
// ARQUITETURA DE AGREGAÇÃO (a parte mais importante deste arquivo)
//
// dashboard_mensal/{userId_ANO_MES}  -> receitas, despesas, aportes, transferencias, resultado
// dashboard_anual/{userId_ANO}       -> receitas, despesas, aportes, transferencias, resultado
//
// Toda vez que uma transação é criada ou excluída, os dois documentos de resumo
// correspondentes são atualizados com FieldValue.increment() DENTRO DO MESMO
// WriteBatch da transação — ou tudo grava, ou nada grava (atômico).
//
// O Dashboard NUNCA varre a coleção "transacoes" inteira. Ele só lê:
//   - o documento de dashboard_mensal ou dashboard_anual (1 leitura)
//   - a lista de "contas" do usuário, que já guarda saldoAtual (poucas leituras)
//   - para o gráfico de categorias, uma consulta filtrada por período (não a coleção toda)
//
// Edição de lançamento (mudar valor/categoria/mês) fica FORA do escopo desta v1 —
// só Criar e Excluir mantêm os agregados 100% consistentes por enquanto.
// ============================================================

let usuarioAtual = null;
let contasCache = [];
let categoriasCache = [];

// ------------------------------------------------------------
// AUTENTICAÇÃO
// ------------------------------------------------------------
const googleProvider = new GoogleAuthProvider();

async function garantirPersistencia() {
  // garante que a sessão sobrevive a refresh/fechar aba, ANTES de qualquer login.
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

// ------------------------------------------------------------
// ESTADO DE AUTENTICAÇÃO — só decide o que mostrar DEPOIS que o Firebase
// confirma se há (ou não) um usuário logado. Enquanto isso, fica em "Carregando…".
// ------------------------------------------------------------
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
      // pre-preenche o nome se veio do Google (evita digitar de novo)
      if (user.displayName) {
        document.getElementById('onb-nome').value = user.displayName.split(' ')[0];
      }
      return;
    }

    usuarioAtual = { uid: user.uid, email: user.email, primeiroNome: snap.data().primeiroNome };
    await iniciarApp();
  } catch (e) {
    console.error('Erro ao verificar/iniciar usuário:', e);
    alert('Não foi possível carregar seus dados. Detalhe: ' + (e.message || e) + '\n\nTente recarregar a página. Se persistir, veja o console (F12).');
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
    alert('Não foi possível concluir o cadastro inicial. Detalhe: ' + (e.message || e));
  }
});

// ------------------------------------------------------------
// DADOS PADRÃO — criados automaticamente no primeiro acesso, para o app
// nunca ficar "esperando" contas/categorias/dashboard que não existem ainda.
// ------------------------------------------------------------
async function criarDadosPadrao(uid) {
  const batch = writeBatch(db);

  const contasPadrao = [
    { nome: 'Conta Corrente', tipoConta: 'Conta Corrente', instituicao: '' },
    { nome: 'Cartão de Crédito', tipoConta: 'Cartão de Crédito', instituicao: '' }
  ];
  contasPadrao.forEach(c => {
    const ref = doc(collection(db, 'contas'));
    batch.set(ref, {
      userId: uid, nome: c.nome, tipoConta: c.tipoConta, instituicao: c.instituicao,
      considerarPatrimonio: 'Sim', ativa: 'Sim', saldoAtual: 0,
      diaFechamentoFatura: null, diaVencimentoFatura: null, contaPagamentoFaturaId: null,
      criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
    });
  });

  const categoriasPadrao = [
    ['Alimentação', 'Despesa'], ['Transporte', 'Despesa'], ['Moradia', 'Despesa'],
    ['Lazer', 'Despesa'], ['Saúde', 'Despesa'], ['Educação', 'Despesa'],
    ['Compras', 'Despesa'], ['Investimentos', 'Transferência'],
    ['Salário', 'Receita'], ['Outras Receitas', 'Receita'], ['Sem categoria', 'Despesa']
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
    criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
  }, { merge: true });
  batch.set(doc(db, 'dashboard_anual', chaveAnual(uid, ano)), {
    userId: uid, ano, receitas: 0, despesas: 0, aportes: 0, transferencias: 0, resultado: 0,
    criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
  }, { merge: true });

  await batch.commit();
}

// ------------------------------------------------------------
// INICIALIZAÇÃO DO APP (pós-login)
// ------------------------------------------------------------
async function iniciarApp() {
  try {
    document.getElementById('tela-carregando').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    document.getElementById('saudacao').textContent = 'Olá, ' + usuarioAtual.primeiroNome;

    await carregarContasCategorias();

    // auto-cura: se o usuario ja existe (ex: ficou travado numa versao anterior do app)
    // mas nao tem contas nem categorias, cria os dados padrao agora.
    if (contasCache.length === 0 && categoriasCache.length === 0) {
      await criarDadosPadrao(usuarioAtual.uid);
      await carregarContasCategorias();
    }

    preencherSeletoresAno();
    navegarPara('dashboard');
    await carregarDashboard();
  } catch (e) {
    console.error('Erro ao iniciar o app:', e);
    alert('Ocorreu um erro ao carregar o app. Detalhe: ' + (e.message || e) + '\n\nAbra o Console (F12) para mais detalhes, ou recarregue a página.');
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
  if (tela === 'historico') carregarHistorico();
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

// ------------------------------------------------------------
// CONTAS E CATEGORIAS (cache local, poucas leituras)
// ------------------------------------------------------------
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
}

function renderizarContasCategorias() {
  document.getElementById('tabela-contas').innerHTML = contasCache.map(c => `
    <tr><td>${c.nome}</td><td>${c.tipoConta || ''}</td><td>${c.instituicao || ''}</td></tr>`).join('');
  document.getElementById('tabela-categorias').innerHTML = categoriasCache.map(c => `
    <tr><td>${c.nome}</td><td><span class="tag">${c.tipoPadrao || ''}</span></td></tr>`).join('');
}

document.getElementById('formConta').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, 'contas'), {
      userId: usuarioAtual.uid,
      nome: document.getElementById('c_nome').value,
      tipoConta: document.getElementById('c_tipo').value,
      instituicao: document.getElementById('c_instituicao').value,
      considerarPatrimonio: 'Sim', ativa: 'Sim', saldoAtual: 0,
      diaFechamentoFatura: null, diaVencimentoFatura: null, contaPagamentoFaturaId: null,
      criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
    });
    e.target.reset();
    await carregarContasCategorias();
    renderizarContasCategorias();
  } catch (err) {
    console.error('Erro ao adicionar conta:', err);
    alert('Não foi possível adicionar a conta. Detalhe: ' + (err.message || err));
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
    alert('Não foi possível adicionar a categoria. Detalhe: ' + (err.message || err));
  }
});

// ------------------------------------------------------------
// CHAVES DE AGREGAÇÃO
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// CRIAR TRANSAÇÃO (manual ou importação) — grava tudo atomicamente
// ------------------------------------------------------------
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
    batch.set(doc(db, 'contas', dados.contaId), { saldoAtual: increment(dados.valor), atualizadoEm: serverTimestamp() }, { merge: true });
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

// ------------------------------------------------------------
// EXCLUIR TRANSAÇÃO — reverte os increments
// ------------------------------------------------------------
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
    batch.set(doc(db, 'contas', t.contaId), { saldoAtual: increment(valorReverso), atualizadoEm: serverTimestamp() }, { merge: true });
  }
  const camposMes = camposAgregados(t.tipoMovimento, t.categoriaNome, valorReverso);
  batch.set(doc(db, 'dashboard_mensal', chaveMensal(usuarioAtual.uid, ano, mes)), { ...camposMes, atualizadoEm: serverTimestamp() }, { merge: true });
  const camposAno = camposAgregados(t.tipoMovimento, t.categoriaNome, valorReverso);
  batch.set(doc(db, 'dashboard_anual', chaveAnual(usuarioAtual.uid, ano)), { ...camposAno, atualizadoEm: serverTimestamp() }, { merge: true });
  await batch.commit();
}

// ------------------------------------------------------------
// FORMULÁRIO NOVO LANÇAMENTO
// ------------------------------------------------------------
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
    msg.className = 'msg msg-erro'; msg.textContent = 'Erro: ' + err.message;
  }
});

// ------------------------------------------------------------
// DASHBOARD — lê SÓ os documentos agregados (não varre transacoes)
// ------------------------------------------------------------
document.getElementById('btn-atualizar-dash').addEventListener('click', carregarDashboard);

async function carregarDashboard() {
  document.getElementById('dash-loading').style.display = 'block';
  document.getElementById('dash-conteudo').style.display = 'none';

  try {
    const ano = Number(document.getElementById('d_ano').value);
    const mes = document.getElementById('d_mes').value;

    let dados;
    if (mes) {
      const snap = await getDoc(doc(db, 'dashboard_mensal', chaveMensal(usuarioAtual.uid, ano, Number(mes))));
      dados = snap.exists() ? snap.data() : { receitas: 0, despesas: 0, aportes: 0, transferencias: 0, resultado: 0 };
    } else {
      const snap = await getDoc(doc(db, 'dashboard_anual', chaveAnual(usuarioAtual.uid, ano)));
      dados = snap.exists() ? snap.data() : { receitas: 0, despesas: 0, aportes: 0, transferencias: 0, resultado: 0 };
    }
    // garante zeros em qualquer campo ausente (documento pode existir parcialmente preenchido)
    dados = { receitas: 0, despesas: 0, aportes: 0, transferencias: 0, resultado: 0, ...dados };

    document.getElementById('dash-cards').innerHTML = `
      <div class="card ${dados.resultado >= 0 ? 'pos' : 'neg'}"><div class="label">Resultado</div><div class="valor">${fmtMoeda(dados.resultado)}</div></div>
      <div class="card pos"><div class="label">Receitas</div><div class="valor">${fmtMoeda(dados.receitas)}</div></div>
      <div class="card neg"><div class="label">Despesas</div><div class="valor">${fmtMoeda(Math.abs(dados.despesas))}</div></div>
      <div class="card neutro"><div class="label">Transferências</div><div class="valor">${fmtMoeda(dados.transferencias)}</div></div>
      <div class="card neutro"><div class="label">Aportes</div><div class="valor">${fmtMoeda(Math.abs(dados.aportes))}</div></div>
    `;

    const { inicio, fim } = periodoParaIntervalo(ano, mes);
    const qDespesas = query(collection(db, 'transacoes'),
      where('userId', '==', usuarioAtual.uid),
      where('tipoMovimento', '==', 'Despesa'),
      where('data', '>=', Timestamp.fromDate(inicio)),
      where('data', '<=', Timestamp.fromDate(fim)));
    const snapDesp = await getDocs(qDespesas);
    const porCategoria = {};
    snapDesp.forEach(d => {
      const t = d.data();
      porCategoria[t.categoriaNome] = (porCategoria[t.categoriaNome] || 0) + Math.abs(t.valor);
    });
    const categoriasOrdenadas = Object.entries(porCategoria).sort((a, b) => b[1] - a[1]).slice(0, 8);

    if (window._chartCat) window._chartCat.destroy();
    window._chartCat = new Chart(document.getElementById('graficoCategoria'), {
      type: 'bar',
      data: { labels: categoriasOrdenadas.map(c => c[0]), datasets: [{ data: categoriasOrdenadas.map(c => c[1]), backgroundColor: '#6E2C3B', borderRadius: 6 }] },
      options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } } }
    });

    document.getElementById('tabela-saldos').innerHTML = contasCache.map(c => `
      <tr><td>${c.nome}</td><td class="num ${((c.saldoAtual || 0) < 0) ? 'valor-neg' : 'valor-pos'}">${fmtMoeda(c.saldoAtual || 0)}</td></tr>`).join('');

    document.getElementById('dash-loading').style.display = 'none';
    document.getElementById('dash-conteudo').style.display = 'block';
  } catch (e) {
    console.error('Erro ao carregar o dashboard:', e);
    alert('Não foi possível carregar o dashboard. Detalhe: ' + (e.message || e) +
      (e.message && e.message.includes('index') ? '\n\nSe o erro mencionar um índice, abra o Console (F12) e clique no link para criar o índice no Firestore.' : ''));
    document.getElementById('dash-loading').style.display = 'none';
    document.getElementById('dash-conteudo').style.display = 'block';
  }
}

function periodoParaIntervalo(ano, mes) {
  if (mes) return { inicio: new Date(ano, Number(mes) - 1, 1), fim: new Date(ano, Number(mes), 0, 23, 59, 59) };
  return { inicio: new Date(ano, 0, 1), fim: new Date(ano, 11, 31, 23, 59, 59) };
}

// ------------------------------------------------------------
// HISTÓRICO (últimos 50 lançamentos)
// ------------------------------------------------------------
async function carregarHistorico() {
  try {
    const q = query(collection(db, 'transacoes'), where('userId', '==', usuarioAtual.uid), orderBy('data', 'desc'), limit(50));
    const snap = await getDocs(q);
    document.getElementById('tabela-historico').innerHTML = snap.docs.map(d => {
      const t = d.data();
      const dataFmt = t.data.toDate().toLocaleDateString('pt-BR');
      return `<tr>
        <td>${dataFmt}</td><td><span class="tag">${t.contaNome}</span></td><td>${t.descricao}</td><td>${t.categoriaNome}</td>
        <td class="num ${t.valor < 0 ? 'valor-neg' : 'valor-pos'}">${fmtMoeda(t.valor)}</td>
        <td><button class="btn-excluir" data-id="${d.id}">excluir</button></td>
      </tr>`;
    }).join('');
    document.querySelectorAll('.btn-excluir').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Excluir este lançamento? Os totais do dashboard serão ajustados automaticamente.')) return;
        try {
          await excluirTransacao(btn.dataset.id);
          carregarHistorico();
          carregarDashboard();
        } catch (e) {
          console.error('Erro ao excluir lançamento:', e);
          alert('Não foi possível excluir. Detalhe: ' + (e.message || e));
        }
      });
    });
  } catch (e) {
    console.error('Erro ao carregar histórico:', e);
    alert('Não foi possível carregar o histórico. Detalhe: ' + (e.message || e));
  }
}

// ------------------------------------------------------------
// INVESTIMENTOS
// ------------------------------------------------------------
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
    alert('Não foi possível adicionar a posição. Detalhe: ' + (err.message || err));
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
    alert('Não foi possível carregar os investimentos. Detalhe: ' + (e.message || e));
  }
}

// ------------------------------------------------------------
// ANUAL — le os documentos de dashboard_mensal do ano (nao varre transacoes)
// ------------------------------------------------------------
document.getElementById('btn-atualizar-anual').addEventListener('click', carregarAnual);

async function carregarAnual() {
  try {
    const ano = Number(document.getElementById('a_ano').value || new Date().getFullYear());
    const q = query(collection(db, 'dashboard_mensal'), where('userId', '==', usuarioAtual.uid), where('ano', '==', ano));
    const snap = await getDocs(q);
    const porMes = {};
    for (let m = 1; m <= 12; m++) porMes[m] = { receitas: 0, despesas: 0 };
    snap.forEach(d => {
      const v = d.data();
      porMes[v.mes] = { receitas: v.receitas || 0, despesas: v.despesas || 0 };
    });

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
      options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });
  } catch (e) {
    console.error('Erro ao carregar demonstrativo anual:', e);
    alert('Não foi possível carregar o anual. Detalhe: ' + (e.message || e));
  }
}

// ------------------------------------------------------------
// IMPORTAÇÃO DE CSV
// Colunas: Data, Conta, Descricao, TipoMovimento, Categoria, Valor, Fixa, Parcela, TotalParcelas, Observacao
// Deduplicação: chave = data|conta|descricao|valor. Se já existir para o usuário, a linha é pulada.
// ------------------------------------------------------------
document.getElementById('btn-importar-csv').addEventListener('click', () => {
  const file = document.getElementById('csv-file').files[0];
  const progresso = document.getElementById('csv-progresso');
  if (!file) { progresso.className = 'msg msg-erro'; progresso.textContent = 'Escolha um arquivo CSV primeiro.'; return; }

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: async (results) => {
      progresso.className = 'msg'; progresso.textContent = `Processando ${results.data.length} linhas…`;
      let importadas = 0, ignoradas = 0, erros = 0;

      try {
        for (const linha of results.data) {
        try {
          const dataStr = converterDataCsv(linha.Data);
          if (!dataStr) { erros++; continue; }
          const contaNome = (linha.Conta || '').trim();
          const descricao = (linha.Descricao || '').trim();
          const valor = Number(String(linha.Valor).replace(',', '.'));
          if (!contaNome || !descricao || isNaN(valor)) { erros++; continue; }

          const chave = `${dataStr}|${contaNome}|${descricao}|${valor}`;
          const qDup = query(collection(db, 'transacoes'),
            where('userId', '==', usuarioAtual.uid), where('chaveDeduplicacao', '==', chave), limit(1));
          const dup = await getDocs(qDup);
          if (!dup.empty) { ignoradas++; continue; }

          let conta = contasCache.find(c => c.nome.toLowerCase() === contaNome.toLowerCase());
          if (!conta) {
            const novaContaRef = await addDoc(collection(db, 'contas'), {
              userId: usuarioAtual.uid, nome: contaNome, tipoConta: '', instituicao: '',
              considerarPatrimonio: 'Sim', ativa: 'Sim', saldoAtual: 0,
              criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
            });
            conta = { id: novaContaRef.id, nome: contaNome, saldoAtual: 0 };
            contasCache.push(conta);
          }

          const categoriaNome = (linha.Categoria || 'Sem categoria').trim();
          let categoria = categoriasCache.find(c => c.nome.toLowerCase() === categoriaNome.toLowerCase());
          if (!categoria) {
            const novaCatRef = await addDoc(collection(db, 'categorias'), {
              userId: usuarioAtual.uid, nome: categoriaNome, tipoPadrao: linha.TipoMovimento || 'Despesa',
              ativa: 'Sim', observacao: 'Criada automaticamente na importação.',
              criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp()
            });
            categoria = { id: novaCatRef.id, nome: categoriaNome };
            categoriasCache.push(categoria);
          }

          await criarTransacao({
            data: dataStr, contaId: conta.id, contaNome: conta.nome,
            categoriaId: categoria.id, categoriaNome: categoria.nome,
            descricao, tipoMovimento: linha.TipoMovimento || (valor < 0 ? 'Despesa' : 'Receita'),
            valor, fixa: linha.Fixa || 'Nao',
            parcela: linha.Parcela || null, totalParcelas: linha.TotalParcelas || null,
            observacao: linha.Observacao || '', origem: 'csv', arquivoOrigem: file.name,
            chaveDeduplicacao: chave, criadoVia: 'importacao_csv'
          });
          importadas++;
        } catch (err) {
          erros++;
        }
        if ((importadas + ignoradas + erros) % 10 === 0) {
          progresso.textContent = `Processando… ${importadas} importadas, ${ignoradas} já existiam, ${erros} com erro.`;
        }
      }

      progresso.className = 'msg msg-ok';
      progresso.textContent = `Concluído: ${importadas} importadas, ${ignoradas} já existiam (ignoradas), ${erros} com erro.`;
      carregarDashboard();
      } catch (e) {
        console.error('Erro geral na importação do CSV:', e);
        progresso.className = 'msg msg-erro';
        progresso.textContent = 'Erro na importação: ' + (e.message || e);
        alert('A importação foi interrompida por um erro. Detalhe: ' + (e.message || e));
      }
    }
  });
});

function converterDataCsv(valor) {
  if (!valor) return null;
  const partes = String(valor).trim().split('/');
  if (partes.length !== 3) return null;
  const [dd, mm, yyyy] = partes;
  if (!dd || !mm || !yyyy) return null;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

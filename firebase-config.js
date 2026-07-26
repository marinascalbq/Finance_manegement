// ============================================================
// CONFIGURAÇÃO DO FIREBASE
// Substitua os valores abaixo pelos do SEU projeto Firebase.
// Onde encontrar: Console do Firebase > Configurações do projeto (ícone de
// engrenagem) > Geral > "Seus apps" > app da Web > SDK setup and configuration.
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAxV_rMXp_rPdAOiI7kO3V2h6qEGFkRKxk",
  authDomain: "orcamento-pessoal-6e2e6.firebaseapp.com",
  projectId: "orcamento-pessoal-6e2e6",
  storageBucket: "orcamento-pessoal-6e2e6.firebasestorage.app",
  messagingSenderId: "822999970105",
  appId: "1:822999970105:web:96890fb371d81353bef8e8"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);

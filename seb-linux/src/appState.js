const { SebSession } = require("./session");

let currentSession = null;

function createSession(filePath) {
  currentSession = new SebSession();
  currentSession.loadFromFile(filePath);
  return currentSession;
}

function setSession(session) {
  currentSession = session;
}

function getSession() {
  return currentSession;
}

function clearSession() {
  currentSession = null;
}

function getStartUrl() {
  if (!currentSession) return null;
  return currentSession.startUrl;
}

function shouldAllowQuit() {
  if (!currentSession) return true;
  return currentSession.allowQuit;
}

module.exports = { createSession, setSession, getSession, clearSession, getStartUrl, shouldAllowQuit };

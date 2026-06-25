const vscode = acquireVsCodeApi();

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");

document.getElementById("btn-clear").addEventListener("click", () => {
  vscode.postMessage({ type: "clear" });
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  vscode.postMessage({ type: "send", text });
}

function addMessage(role, content) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = content;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function clearMessages() {
  messagesEl.innerHTML = "";
}

window.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "addMessage":
      addMessage(message.role, message.content);
      break;
    case "clear":
      clearMessages();
      break;
  }
});

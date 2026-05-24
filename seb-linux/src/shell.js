(function () {
  const shellRoot = document.getElementById("shellRoot");
  const loadingBar = document.getElementById("loadingBar");
  const joinPanel = document.getElementById("joinPanel");
  const formError = document.getElementById("formError");
  const startUrlInput = document.getElementById("startUrl");
  const browserExamKeyInput = document.getElementById("browserExamKey");
  const joinBtn = document.getElementById("joinBtn");
  const importBtn = document.getElementById("importBtn");
  const reloadBtn = document.getElementById("reloadBtn");
  const menuBtn = document.getElementById("menuBtn");
  const toolbarMenu = document.getElementById("toolbarMenu");
  const clockTime = document.getElementById("clockTime");
  const clockDate = document.getElementById("clockDate");
  const batteryLevel = document.getElementById("batteryLevel");
  const keyboardText = document.getElementById("keyboardText");
  const quitBtn = document.getElementById("quitBtn");
  const quitModal = document.getElementById("quitModal");
  const quitModalText = document.getElementById("quitModalText");
  const quitModalPassword = document.getElementById("quitModalPassword");
  const quitModalError = document.getElementById("quitModalError");
  const confirmQuitBtn = document.getElementById("confirmQuitBtn");
  const cancelQuitBtn = document.getElementById("cancelQuitBtn");
  const toast = document.getElementById("toast");

  let currentState = null;
  let joinLoading = false;
  let batteryHandle = null;
  let hideToastTimer = null;

  function showFormError(message) {
    formError.textContent = message;
    formError.hidden = false;
  }

  function clearFormError() {
    formError.hidden = true;
    formError.textContent = "";
  }

  function showQuitError(message) {
    quitModalError.textContent = message;
    quitModalError.hidden = false;
  }

  function clearQuitError() {
    quitModalError.hidden = true;
    quitModalError.textContent = "";
  }

  function showToast(message) {
    if (hideToastTimer) {
      window.clearTimeout(hideToastTimer);
      hideToastTimer = null;
    }

    toast.textContent = message;
    toast.hidden = false;
    hideToastTimer = window.setTimeout(function () {
      toast.hidden = true;
      hideToastTimer = null;
    }, 2800);
  }

  function setJoinLoading(loading) {
    joinLoading = loading;
    joinBtn.disabled = loading;
    importBtn.disabled = loading;
    joinBtn.textContent = loading ? "Starting..." : "Start Exam";
    importBtn.textContent = loading ? "Working..." : "Import .seb File";
  }

  function setToolbarMenuOpen(open) {
    toolbarMenu.hidden = !open;
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function openQuitModal() {
    if (shellRoot.dataset.mode !== "exam") {
      closeQuitModal();
      return;
    }

    clearQuitError();
    quitModal.hidden = false;
    if (currentState && currentState.requiresQuitPassword) {
      quitModalText.textContent = "Enter the quit password to close the exam session.";
    } else {
      quitModalText.textContent = "Confirm that Safe Exam Browser should be closed.";
    }
    quitModalPassword.value = "";
    if (currentState && currentState.requiresQuitPassword) {
      quitModalPassword.focus();
    } else {
      confirmQuitBtn.focus();
    }
  }

  function closeQuitModal() {
    quitModal.hidden = true;
    clearQuitError();
    quitModalPassword.value = "";
  }

  function updateClock() {
    const now = new Date();
    clockTime.textContent = now.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    clockDate.textContent = now.toLocaleDateString([], {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  }

  function updateKeyboardWidget() {
    keyboardText.textContent = "ENG";
  }

  function applyBatteryState() {
    const widget = document.getElementById("batteryWidget");
    const maxFillWidth = 18;
    if (!batteryHandle) {
      batteryLevel.setAttribute("width", String(Math.round(maxFillWidth * 0.86)));
      widget.classList.remove("battery-green", "battery-yellow", "battery-red");
      widget.classList.add("battery-green");
      return;
    }

    const level = Math.round(batteryHandle.level * 100);
    const width = Math.max(2, Math.round((level / 100) * maxFillWidth));
    batteryLevel.setAttribute("width", String(width));

    widget.classList.remove("battery-green", "battery-yellow", "battery-red");
    if (level > 50) {
      widget.classList.add("battery-green");
    } else if (level > 20) {
      widget.classList.add("battery-yellow");
    } else {
      widget.classList.add("battery-red");
    }

    widget.title = batteryHandle.charging
      ? "Battery charging"
      : "Battery";
  }

  function validateJoinForm() {
    const startUrl = startUrlInput.value.trim();
    const browserExamKey = browserExamKeyInput.value.trim();

    if (!startUrl) {
      return { ok: false, error: "Please enter the exam / start URL.", focus: startUrlInput };
    }

    if (!/^https?:\/\//i.test(startUrl) && !/^file:\/\//i.test(startUrl)) {
      return {
        ok: false,
        error: "Start URL must begin with http://, https://, or file://",
        focus: startUrlInput,
      };
    }

    if (browserExamKey && browserExamKey.length !== 64) {
      return {
        ok: false,
        error: "Browser Exam Key must be exactly 64 hex characters if provided.",
        focus: browserExamKeyInput,
      };
    }

    if (browserExamKey && !/^[0-9a-fA-F]{64}$/.test(browserExamKey)) {
      return {
        ok: false,
        error: "Browser Exam Key contains invalid characters. Use only 0-9 and a-f.",
        focus: browserExamKeyInput,
      };
    }

    return { ok: true };
  }

  async function handleJoin() {
    if (joinLoading) return;

    clearFormError();
    const validation = validateJoinForm();
    if (!validation.ok) {
      showFormError(validation.error);
      validation.focus.focus();
      return;
    }

    setJoinLoading(true);

    try {
      const result = await window.sebAPI.submitJoinExam({
        startUrl: startUrlInput.value.trim(),
        browserExamKey: browserExamKeyInput.value.trim() || null,
        quitPassword: null,
      });

      if (!result.success) {
        showFormError(result.error || "Failed to start the exam.");
        setJoinLoading(false);
      }
    } catch (error) {
      showFormError("Failed to start the exam: " + (error.message || "unknown error"));
      setJoinLoading(false);
    }
  }

  async function handleImport() {
    if (joinLoading) return;

    clearFormError();
    setJoinLoading(true);

    try {
      const result = await window.sebAPI.importSebConfig();
      if (!result.success) {
        if (!result.canceled) {
          showFormError(result.error || "Failed to import SEB config.");
        }
        setJoinLoading(false);
      }
    } catch (error) {
      showFormError("Failed to import SEB config: " + (error.message || "unknown error"));
      setJoinLoading(false);
    }
  }

  async function handleShellAction(action) {
    try {
      const nextState = await window.sebAPI.runShellAction(action);
      applyShellState(nextState);
    } catch (error) {
      showToast("SEB action failed: " + (error.message || "unknown error"));
    }
  }

  async function handleQuit() {
    if (shellRoot.dataset.mode !== "exam") {
      await window.sebAPI.tryQuit("");
      return;
    }

    if (currentState && currentState.quitEnabled === false) {
      showToast("Quitting is disabled by the current exam settings.");
      return;
    }

    if (currentState && currentState.requiresQuitPassword) {
      openQuitModal();
      return;
    }

    const success = await window.sebAPI.tryQuit("");
    if (!success) {
      openQuitModal();
    }
  }

  async function confirmQuit() {
    clearQuitError();
    confirmQuitBtn.disabled = true;

    try {
      const success = await window.sebAPI.tryQuit(quitModalPassword.value);
      if (!success) {
        showQuitError("The quit password is not valid for this session.");
        quitModalPassword.focus();
      }
    } catch (error) {
      showQuitError("Failed to quit Safe Exam Browser: " + (error.message || "unknown error"));
    } finally {
      confirmQuitBtn.disabled = false;
    }
  }

  function applyShellState(state) {
    if (!state) return;

    currentState = state;

    shellRoot.dataset.mode = state.examActive ? "exam" : "join";
    joinPanel.hidden = state.examActive;

    if (!state.examActive) {
      setJoinLoading(false);
      closeQuitModal();
    }

    reloadBtn.disabled = !state.examActive;
    quitBtn.disabled = state.quitEnabled === false;
    loadingBar.classList.toggle("is-loading", !!state.isLoading);

    if (state.joinUrl && !startUrlInput.value) {
      startUrlInput.value = state.joinUrl;
    }
  }

  function bindMenuActions() {
    toolbarMenu.addEventListener("click", function (event) {
      const button = event.target.closest("[data-action]");
      if (!button) return;

      const action = button.getAttribute("data-action");
      setToolbarMenuOpen(false);

      if (action === "quit") {
        handleQuit();
        return;
      }

      handleShellAction(action);
    });

    document.addEventListener("click", function (event) {
      if (toolbarMenu.hidden) return;
      if (toolbarMenu.contains(event.target) || menuBtn.contains(event.target)) return;
      setToolbarMenuOpen(false);
    });
  }

  function bindToolbarButtons() {
    reloadBtn.addEventListener("click", function () {
      handleShellAction("reload");
    });
    menuBtn.addEventListener("click", function () {
      setToolbarMenuOpen(toolbarMenu.hidden);
    });
    quitBtn.addEventListener("click", handleQuit);
  }

  function bindJoinForm() {
    joinBtn.addEventListener("click", handleJoin);
    importBtn.addEventListener("click", handleImport);

    startUrlInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        handleJoin();
      }
    });
    browserExamKeyInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        handleJoin();
      }
    });
  }

  function bindQuitModal() {
    cancelQuitBtn.addEventListener("click", closeQuitModal);
    confirmQuitBtn.addEventListener("click", confirmQuit);
    quitModal.addEventListener("click", function (event) {
      if (event.target === quitModal) {
        closeQuitModal();
      }
    });
    quitModalPassword.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        confirmQuit();
      } else if (event.key === "Escape") {
        closeQuitModal();
      }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !quitModal.hidden) {
        closeQuitModal();
      }
    });
  }

  function initializeWidgets() {
    updateClock();
    updateKeyboardWidget();
    window.setInterval(updateClock, 1000);

    if (navigator.getBattery) {
      navigator.getBattery().then(function (battery) {
        batteryHandle = battery;
        applyBatteryState();
        battery.addEventListener("chargingchange", applyBatteryState);
        battery.addEventListener("levelchange", applyBatteryState);
      }).catch(function () {
        applyBatteryState();
      });
    } else {
      applyBatteryState();
    }
  }

  async function initialize() {
    bindJoinForm();
    bindToolbarButtons();
    bindMenuActions();
    bindQuitModal();
    initializeWidgets();

    window.sebAPI.onShellState(function (state) {
      applyShellState(state);
    });

    try {
      const state = await window.sebAPI.getShellState();
      applyShellState(state);
      clearFormError();
      if (state && state.joinUrl) {
        startUrlInput.value = state.joinUrl;
      }
    } catch (error) {
      showFormError("Failed to load Safe Exam Browser UI: " + (error.message || "unknown error"));
    }

    startUrlInput.focus();
  }

  initialize();
})();

// FastAF mobile login form. Posts the credentials as JSON to /auth/login;
// the server answers with the session cookie, then the page returns to the app.
(() => {
  const form = document.getElementById("login");
  const error = document.getElementById("error");
  const submit = document.getElementById("submit");

  const messages = {
    401: "Wrong username or password.",
    403: "Login refused: open this page from the FastAF address.",
    429: "Too many attempts. Try again later.",
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    try {
      const next = new URLSearchParams(location.search).get("next");
      const response = await fetch("/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.elements.username.value,
          password: form.elements.password.value,
          next,
        }),
      });
      if (response.ok) {
        const body = await response.json();
        // Redirects inherit the original fragment; keep it after the form login.
        location.replace((body.next || "/mobile") + (location.hash || ""));
        return;
      }
      error.textContent = messages[response.status] || `Login failed (${response.status}).`;
    } catch {
      error.textContent = "Server unreachable. Try again.";
    }
    submit.disabled = false;
  });
})();

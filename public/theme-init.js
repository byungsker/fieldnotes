/* global window, document */
(() => {
  let theme = "dark";
  try {
    theme = window.localStorage.getItem("fieldnotes:theme") === "light" ? "light" : "dark";
  } catch {
    // The dark default works without browser storage.
  }
  document.documentElement.dataset.theme = theme;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute("content", theme === "dark" ? "#171d19" : "#f7f7f5");
})();

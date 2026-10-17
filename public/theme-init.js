/* global window, document */
(() => {
  let theme = "dark";
  try {
    theme = window.localStorage.getItem("fieldnotes:theme") === "light" ? "light" : "dark";
  } catch {
    // The dark default works without browser storage.
  }
  document.documentElement.dataset.theme = theme;
  // 스타일시트가 준비된 후 앱과 같은 바탕색을 브라우저 UI에도 적용한다.
  document.addEventListener("DOMContentLoaded", () => {
    const canvas = window.getComputedStyle(document.documentElement).getPropertyValue("--ds-color-canvas").trim();
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (canvas && themeColor) themeColor.setAttribute("content", canvas);
  }, { once: true });
})();

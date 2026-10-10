/* π-starter project overview — interactions: metrics, nav highlight, progress, theme,
   tabs, copy, count-up, reveal, back-to-top, mobile menu. No dependencies. */
(function () {
  "use strict";

  /* ---------- metrics ----------
     The object between the markers below is written by
     scripts/visualization/generate_overview.mjs (`npm run docs:overview`), which reads
     scripts/visualization/metrics.mjs — the same source behind the README metric tables.
     `npm run docs:overview:check` fails the build when this page and the code disagree,
     so no number on this page is hand-copied. Do not edit between the markers. */
  /* BEGIN:generated-metrics */
  var METRICS = {
  "version": "0.4.1",
  "releaseTag": "v0.4.1",
  "license": "MIT",
  "enginesNode": ">=22.19",
  "sdkVersion": "0.83.0",
  "expressVersion": "^5.2.1",
  "typeboxVersion": "^1.1.39",
  "wsVersion": "^8.18.0",
  "transformersVersion": "^4.3.1",
  "typescriptVersion": "^5.6.0",
  "reactVersion": "^19.2.8",
  "viteVersion": "^8.3.0",
  "assistantUiVersion": "^0.15.25",
  "maxOpenConversations": 8,
  "wsPath": "/ws",
  "defaultHost": "127.0.0.1",
  "srcFiles": 84,
  "srcLines": 19983,
  "testFiles": 53,
  "testCases": 505,
  "frontendCases": 19,
  "webFiles": 36,
  "webLines": 8751,
  "routes": 47,
  "docFiles": 10,
  "largestFile": "src/conversation/conversation.ts",
  "largestLines": 1137,
  "smokeChecks": 23,
  "e2eChecks": 48,
  "gateCount": 9,
  "covLines": 92,
  "covBranches": 81,
  "covFunctions": 85,
  "generatedAt": "2026-10-10"
};
  /* END:generated-metrics */

  Array.prototype.forEach.call(document.querySelectorAll("[data-metric]"), function (el) {
    var value = METRICS[el.getAttribute("data-metric")];
    if (value !== undefined && value !== null) el.textContent = String(value);
  });

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- theme: follow system, persist manual choice ---------- */
  var root = document.documentElement;
  var themeBtn = document.getElementById("themeToggle");
  function applyTheme(t) {
    if (t === "light" || t === "dark") root.setAttribute("data-theme", t);
    else root.removeAttribute("data-theme"); // follow system
    if (themeBtn) themeBtn.textContent = t === "light" ? "☀" : (t === "dark" ? "☾" : "◐");
  }
  var saved = null;
  try { saved = localStorage.getItem("pi-ov-theme"); } catch (e) {}
  applyTheme(saved || "auto");
  if (themeBtn) themeBtn.addEventListener("click", function () {
    var cur = root.getAttribute("data-theme");
    var next = cur === "light" ? "dark" : "light"; // toggle between the two
    applyTheme(next);
    try { localStorage.setItem("pi-ov-theme", next); } catch (e) {}
  });

  /* ---------- scroll progress bar ---------- */
  var progress = document.getElementById("progress");
  function onScroll() {
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    var pct = max > 0 ? (h.scrollTop || document.body.scrollTop) / max * 100 : 0;
    if (progress) progress.style.width = pct + "%";
    var btn = document.getElementById("backTop");
    if (btn) btn.classList.toggle("show", (h.scrollTop || 0) > window.innerHeight);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- back to top ---------- */
  var backTop = document.getElementById("backTop");
  if (backTop) backTop.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  });

  /* ---------- mobile hamburger ---------- */
  var burger = document.getElementById("hamburger");
  var navlinks = document.getElementById("navlinks");
  if (burger && navlinks) burger.addEventListener("click", function () {
    navlinks.classList.toggle("open");
  });
  if (navlinks) navlinks.addEventListener("click", function (e) {
    if (e.target.tagName === "A") navlinks.classList.remove("open");
  });

  /* ---------- active nav link via IntersectionObserver ---------- */
  var sections = Array.prototype.slice.call(document.querySelectorAll("main section[id]"));
  var linkById = {};
  Array.prototype.forEach.call(document.querySelectorAll(".links a"), function (a) {
    linkById[a.getAttribute("href").slice(1)] = a;
  });
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var id = en.target.id;
        var link = linkById[id];
        if (!link) return;
        if (en.isIntersecting) {
          Object.keys(linkById).forEach(function (k) { linkById[k].classList.remove("active"); });
          link.classList.add("active");
        }
      });
    }, { rootMargin: "-45% 0px -50% 0px", threshold: 0 });
    sections.forEach(function (s) { io.observe(s); });
  }

  /* ---------- tabs ---------- */
  Array.prototype.forEach.call(document.querySelectorAll("[data-tabs]"), function (group) {
    var btns = group.querySelectorAll(".tab-btn");
    var panels = group.querySelectorAll(".tab-panel");
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener("click", function () {
        var name = b.getAttribute("data-tab");
        Array.prototype.forEach.call(btns, function (x) { x.classList.toggle("active", x === b); });
        Array.prototype.forEach.call(panels, function (p) { p.classList.toggle("active", p.getAttribute("data-panel") === name); });
      });
    });
  });

  /* ---------- copy buttons ---------- */
  Array.prototype.forEach.call(document.querySelectorAll(".copy"), function (btn) {
    btn.addEventListener("click", function () {
      var block = btn.closest(".codeblock");
      var pre = block ? block.querySelector("pre:last-of-type") : null;
      var text = pre ? pre.innerText : "";
      var done = function () { btn.textContent = "copied"; btn.classList.add("done"); setTimeout(function () { btn.textContent = "copy"; btn.classList.remove("done"); }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, done); }
      else { try { var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); done(); } catch (e) {} }
    });
  });

  /* ---------- count-up numbers ---------- */
  function targetOf(el) {
    var key = el.getAttribute("data-metric");
    if (key && typeof METRICS[key] === "number") return METRICS[key];
    if (el.getAttribute("data-count") !== null) return parseInt(el.getAttribute("data-count"), 10) || 0;
    // A metric the generator does not know about keeps the number that is already in the HTML,
    // so the page degrades to the committed value instead of collapsing to zero.
    return parseInt((el.textContent || "").replace(/[^\d]/g, ""), 10) || 0;
  }
  function animateNum(el) {
    var target = targetOf(el);
    if (reduceMotion) { el.textContent = String(target); return; }
    var dur = 1200, start = null;
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  var nums = document.querySelectorAll(".num[data-metric], .num[data-count]");
  if ("IntersectionObserver" in window) {
    var nio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { animateNum(en.target); nio.unobserve(en.target); }
      });
    }, { threshold: 0.4 });
    Array.prototype.forEach.call(nums, function (n) { nio.observe(n); });
  } else {
    Array.prototype.forEach.call(nums, animateNum);
  }

  /* ---------- reveal on scroll ---------- */
  Array.prototype.forEach.call(document.querySelectorAll("section .grid-2, section .grid-3, section .table-wrap, section .tabs, section .tree, section .cap-grid, section .diagram, section .callout, section .doclist"), function (el) {
    el.classList.add("reveal");
  });
  if ("IntersectionObserver" in window && !reduceMotion) {
    var rio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add("in"); rio.unobserve(en.target); } });
    }, { threshold: 0.12 });
    Array.prototype.forEach.call(document.querySelectorAll(".reveal"), function (el) { rio.observe(el); });
  } else {
    Array.prototype.forEach.call(document.querySelectorAll(".reveal"), function (el) { el.classList.add("in"); });
  }
})();

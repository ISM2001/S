/* RAYO — shared site behavior. No localStorage: cart lives in memory
   for the length of the session, per-tab. */

(function () {
  "use strict";

  /* ---------- Product catalogue (mirrors modelos.html) ---------- */
  const PRODUCTS = {
    uno:    { name: "RAYO Uno",    price: 449, tag: "Urbano ligero" },
    cima:   { name: "RAYO Cima",   price: 799, tag: "Largo alcance" },
    fuerza: { name: "RAYO Fuerza", price: 1190, tag: "Doble motor todo-terreno" }
  };

  let cart = []; // [{id, qty}]

  /* ---------- Nav scroll state ---------- */
  const nav = document.querySelector(".nav");
  function onScroll() {
    if (!nav) return;
    if (window.scrollY > 24) nav.classList.add("scrolled");
    else nav.classList.remove("scrolled");
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- Mobile nav toggle ---------- */
  const navToggle = document.querySelector(".nav-toggle");
  const navLinks = document.querySelector(".nav-links");
  if (navToggle && navLinks) {
    navToggle.addEventListener("click", () => {
      const open = navLinks.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
      navToggle.textContent = open ? "Cerrar" : "Menu";
    });
    navLinks.querySelectorAll("a").forEach((a) =>
      a.addEventListener("click", () => {
        navLinks.classList.remove("open");
        navToggle.textContent = "Menu";
      })
    );
  }

  /* ---------- Scroll reveal ---------- */
  const revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && revealEls.length) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("in"));
  }

  /* ---------- Tabs (trust / origin section) ---------- */
  document.querySelectorAll("[data-tabs]").forEach((group) => {
    const btns = group.querySelectorAll(".tab-btn");
    const panels = group.querySelectorAll(".tab-panel");
    btns.forEach((btn, i) => {
      btn.addEventListener("click", () => {
        btns.forEach((b) => b.classList.remove("active"));
        panels.forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        panels[i].classList.add("active");
      });
    });
  });

  /* ---------- FAQ accordion ---------- */
  document.querySelectorAll(".faq-item").forEach((item) => {
    const q = item.querySelector(".faq-q");
    if (!q) return;
    q.addEventListener("click", () => {
      const isOpen = item.classList.contains("open");
      item.closest(".faq-list")?.querySelectorAll(".faq-item").forEach((i) => i.classList.remove("open"));
      if (!isOpen) item.classList.add("open");
    });
  });

  /* ---------- Chooser / quiz ---------- */
  const chooser = document.querySelector("[data-chooser]");
  if (chooser) {
    const state = { uso: null, alcance: null };
    const resultName = chooser.querySelector(".rec-name");
    const resultCopy = chooser.querySelector(".rec-copy");
    const resultBtn = chooser.querySelector(".rec-cta");

    function recommend() {
      if (!state.uso || !state.alcance) return;
      let pick = "uno";
      if (state.uso === "ciudad" && state.alcance === "largo") pick = "cima";
      if (state.uso === "mixto") pick = "cima";
      if (state.uso === "montana") pick = "fuerza";
      if (state.alcance === "largo" && state.uso !== "montana") pick = "cima";
      const p = PRODUCTS[pick];
      resultName.textContent = p.name;
      resultCopy.textContent = `Recomendado para ti — ${p.tag.toLowerCase()}, desde ${p.price} €.`;
      resultBtn.href = `modelos.html#${pick}`;
      resultBtn.classList.remove("btn-ghost");
      resultBtn.classList.add("btn-accent");
    }

    chooser.querySelectorAll(".chooser-opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        const group = btn.closest(".chooser-q");
        group.querySelectorAll(".chooser-opt").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const key = group.dataset.key;
        state[key] = btn.dataset.value;
        recommend();
      });
    });
  }

  /* ---------- Cart drawer ---------- */
  const cartOverlay = document.querySelector(".cart-overlay");
  const cartDrawer = document.querySelector(".cart-drawer");
  const cartItemsEl = document.querySelector(".cart-items");
  const cartCountEl = document.querySelector(".cart-count");
  const cartTotalEl = document.querySelector(".cart-total-value");

  function renderCart() {
    if (!cartItemsEl) return;
    const count = cart.reduce((n, i) => n + i.qty, 0);
    if (cartCountEl) cartCountEl.textContent = count;

    if (!cart.length) {
      cartItemsEl.innerHTML = `<div class="cart-empty">Tu cesta está vacía.<br>Explora los modelos RAYO.</div>`;
    } else {
      cartItemsEl.innerHTML = cart
        .map((item) => {
          const p = PRODUCTS[item.id];
          return `
          <div class="cart-item" data-id="${item.id}">
            <div class="thumb"></div>
            <div class="info">
              <b>${p.name}</b>
              <span>${p.tag} · x${item.qty}</span>
            </div>
            <button class="remove" data-remove="${item.id}">Quitar</button>
          </div>`;
        })
        .join("");
    }
    const total = cart.reduce((sum, i) => sum + PRODUCTS[i.id].price * i.qty, 0);
    if (cartTotalEl) cartTotalEl.textContent = total.toLocaleString("es-ES") + " €";

    cartItemsEl.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        cart = cart.filter((i) => i.id !== btn.dataset.remove);
        renderCart();
      });
    });
  }

  function openCart() {
    cartOverlay?.classList.add("open");
    cartDrawer?.classList.add("open");
  }
  function closeCart() {
    cartOverlay?.classList.remove("open");
    cartDrawer?.classList.remove("open");
  }

  document.querySelectorAll("[data-cart-open]").forEach((b) => b.addEventListener("click", openCart));
  document.querySelectorAll("[data-cart-close]").forEach((b) => b.addEventListener("click", closeCart));
  cartOverlay?.addEventListener("click", closeCart);

  document.querySelectorAll("[data-add-to-cart]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const id = btn.dataset.addToCart;
      if (!PRODUCTS[id]) return;
      const existing = cart.find((i) => i.id === id);
      if (existing) existing.qty += 1;
      else cart.push({ id, qty: 1 });
      renderCart();
      openCart();
    });
  });

  renderCart();

  /* ---------- Contact / newsletter forms (front-end only demo) ---------- */
  document.querySelectorAll("[data-demo-form]").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const note = form.querySelector(".form-note");
      if (note) {
        note.textContent = "Gracias — nuestro equipo te responderá en menos de 24 h.";
        note.style.color = "var(--cobalt)";
      }
      form.reset();
    });
  });
})();

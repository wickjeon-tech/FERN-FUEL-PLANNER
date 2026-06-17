/* ============================================
   FERN — Main JavaScript
   Navigation, Scroll Animations & Reveal Effects
   ============================================ */

document.addEventListener('DOMContentLoaded', () => {
  initHeader();
  initMobileMenu();
  initScrollReveal();
  initCounterAnimation();
});

/**
 * 1. Header scroll effect
 */
function initHeader() {
  const header = document.querySelector('.header');
  if (!header) return;

  const checkScroll = () => {
    if (window.scrollY > 50) {
      header.classList.add('is-scrolled');
    } else {
      header.classList.remove('is-scrolled');
    }
  };

  // Check on load
  checkScroll();
  
  // Check on scroll
  window.addEventListener('scroll', checkScroll, { passive: true });
}

/**
 * 2. Mobile Menu Toggle
 */
function initMobileMenu() {
  const toggleBtn = document.querySelector('.header__menu-toggle');
  const mobileNav = document.querySelector('.mobile-nav');
  
  if (!toggleBtn || !mobileNav) return;

  toggleBtn.addEventListener('click', () => {
    const isOpen = toggleBtn.classList.toggle('is-open');
    mobileNav.classList.toggle('is-open', isOpen);
    
    // Prevent body scroll when mobile menu is open
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
  });

  // Close mobile menu on resize to desktop width
  window.addEventListener('resize', () => {
    if (window.innerWidth >= 768 && mobileNav.classList.contains('is-open')) {
      toggleBtn.classList.remove('is-open');
      mobileNav.classList.remove('is-open');
      document.body.style.overflow = '';
    }
  });
}

/**
 * 3. Scroll Reveal Animations (using Intersection Observer)
 */
function initScrollReveal() {
  const revealElements = document.querySelectorAll('.reveal');
  if (revealElements.length === 0) return;

  const observerOptions = {
    root: null,
    rootMargin: '0px',
    threshold: 0.15
  };

  const observer = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target); // Animates only once
      }
    });
  }, observerOptions);

  revealElements.forEach(el => observer.observe(el));
}

/**
 * 4. Metrics Counter Animation
 */
function initCounterAnimation() {
  const counters = document.querySelectorAll('.counter');
  if (counters.length === 0) return;

  const observerOptions = {
    root: null,
    rootMargin: '0px',
    threshold: 0.5
  };

  const startCounting = (counterEl) => {
    const target = parseFloat(counterEl.getAttribute('data-target'));
    const isDecimal = counterEl.getAttribute('data-decimal') === 'true';
    const duration = 2000; // 2 seconds
    const startTime = performance.now();

    const updateCount = (currentTime) => {
      const elapsedTime = currentTime - startTime;
      const progress = Math.min(elapsedTime / duration, 1);
      
      // Easing function (outQuad)
      const easeProgress = progress * (2 - progress);
      const currentVal = easeProgress * target;

      if (isDecimal) {
        // Format e.g., 2:1.6
        // If target is like 1.6, we count from 0 to 1.6
        counterEl.textContent = currentVal.toFixed(1);
      } else {
        counterEl.textContent = Math.floor(currentVal);
      }

      if (progress < 1) {
        requestAnimationFrame(updateCount);
      } else {
        counterEl.textContent = isDecimal ? target.toFixed(1) : target;
      }
    };

    requestAnimationFrame(updateCount);
  };

  const observer = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        startCounting(entry.target);
        observer.unobserve(entry.target);
      }
    });
  }, observerOptions);

  counters.forEach(counter => observer.observe(counter));
}

/**
 * Utility: Toast notification function (used in cart.js but defined globally or accessible)
 */
window.showToast = function(message) {
  let toast = document.querySelector('.toast');
  
  // Create toast element if it doesn't exist
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
      <span class="toast__icon">✓</span>
      <span class="toast__text"></span>
    `;
    document.body.appendChild(toast);
  }

  const toastText = toast.querySelector('.toast__text');
  toastText.textContent = message;

  // Show toast
  toast.classList.add('is-visible');

  // Hide after 3 seconds
  setTimeout(() => {
    toast.classList.remove('is-visible');
  }, 3000);
};

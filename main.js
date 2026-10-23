/* ============================================================================
   Greenlight — behaviour only. All copy lives in index.html.
   No dependencies, no build step: open index.html or serve the folder.
   ========================================================================== */
(function () {
  'use strict';

  var reduceQuery = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: null, addListener: null };
  var reduced = reduceQuery.matches;

  /* ------------------------------------------------------------ Mobile menu */
  var toggle = document.getElementById('menu-toggle');
  var menu = document.getElementById('mobile-menu');

  if (toggle && menu) {
    var setMenu = function (open) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
      if (open) {
        menu.removeAttribute('hidden');
      } else {
        menu.setAttribute('hidden', '');
      }
    };

    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-expanded') !== 'true';
      setMenu(open);
    });

    // A click on any link navigates to the anchor and closes the panel.
    menu.addEventListener('click', function (event) {
      if (event.target.closest('a')) setMenu(false);
    });

    // Escape closes and hands focus back to the toggle.
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (toggle.getAttribute('aria-expanded') !== 'true') return;
      setMenu(false);
      toggle.focus();
    });
  }

  /* ------------------------------------------------------- Diff demo panel */
  var demo = document.getElementById('demo');

  if (demo) {
    // Mirrors the React sequence: lines stagger, then the comment, then the
    // checks one by one, then the status chip flips — all off one clock.
    var LINE_STAGGER = 60;
    var COMMENT_AFTER_LINES = 400;
    var CHECK_AFTER_COMMENT = 600;
    var CHECK_INTERVAL = 500;
    var CHIP_AFTER_LAST_CHECK = 400;

    var lines = document.getElementById('demo-lines');
    var comment = document.getElementById('demo-comment');
    var chip = document.getElementById('demo-chip');
    var chipLabel = chip ? chip.querySelector('.chip__label') : null;
    var checks = Array.prototype.slice.call(demo.querySelectorAll('.check'));
    var replay = document.getElementById('replay-demo');

    var timers = [];
    var started = false;

    var clearTimers = function () {
      timers.forEach(clearTimeout);
      timers = [];
    };

    var setChipLabel = function (ready) {
      if (chipLabel) chipLabel.textContent = ready ? 'Pronto para o merge' : 'Checagens em andamento';
    };

    // Final composed state — what reduced motion renders on first paint.
    var setFinalState = function () {
      clearTimers();
      if (lines) lines.classList.add('is-playing');
      if (comment) comment.classList.add('is-shown');
      checks.forEach(function (check) {
        check.classList.add('is-done');
      });
      if (chip) chip.classList.add('chip--ready');
      setChipLabel(true);
    };

    var reset = function () {
      clearTimers();
      if (lines) lines.classList.remove('is-playing');
      if (comment) comment.classList.remove('is-shown');
      checks.forEach(function (check) {
        check.classList.remove('is-done');
      });
      if (chip) chip.classList.remove('chip--ready');
      setChipLabel(false);
    };

    var play = function () {
      reset();
      // Read a layout property so the removed classes are committed before the
      // stagger is re-applied — otherwise a replay is a no-op.
      if (lines) void lines.offsetWidth;
      if (lines) lines.classList.add('is-playing');

      var lineCount = lines ? lines.children.length : 0;
      var afterLines = lineCount * LINE_STAGGER + COMMENT_AFTER_LINES;
      var afterComment = afterLines + CHECK_AFTER_COMMENT;
      var afterLastCheck = afterComment + (checks.length - 1) * CHECK_INTERVAL;

      timers.push(
        setTimeout(function () {
          if (comment) comment.classList.add('is-shown');
        }, afterLines),
      );

      checks.forEach(function (check, index) {
        timers.push(
          setTimeout(function () {
            check.classList.add('is-done');
          }, afterComment + index * CHECK_INTERVAL),
        );
      });

      timers.push(
        setTimeout(function () {
          if (chip) chip.classList.add('chip--ready');
          setChipLabel(true);
        }, afterLastCheck + CHIP_AFTER_LAST_CHECK),
      );
    };

    if (reduced) {
      setFinalState();
    } else if ('IntersectionObserver' in window) {
      reset();
      var demoObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting || started) return;
            started = true;
            demoObserver.disconnect();
            play();
          });
        },
        { threshold: 0.4 },
      );
      demoObserver.observe(demo);
    } else {
      setFinalState();
    }

    if (replay) {
      replay.addEventListener('click', function () {
        started = true;
        play();
      });
    }

    // Turning the preference on mid-session stops the sequence and composes it.
    var onReducedChange = function (event) {
      reduced = event.matches;
      if (reduced) setFinalState();
    };
    if (reduceQuery.addEventListener) reduceQuery.addEventListener('change', onReducedChange);
    else if (reduceQuery.addListener) reduceQuery.addListener(onReducedChange);
  }

  /* ----------------------------------------------------------- Count-ups */
  var statsBand = document.getElementById('stats');

  if (statsBand) {
    var valueEls = Array.prototype.slice.call(statsBand.querySelectorAll('.stat__value'));

    var render = function (el, shown) {
      var value = parseFloat(el.getAttribute('data-count'));
      var decimals = parseInt(el.getAttribute('data-decimals') || '0', 10);
      var prefix = el.getAttribute('data-prefix') || '';
      var suffix = el.getAttribute('data-suffix') || '';
      el.textContent = prefix + (value * shown).toFixed(decimals) + suffix;
    };

    var countUp = function () {
      var duration = 1400;
      var start = null;
      var step = function (now) {
        if (start === null) start = now;
        var t = Math.min((now - start) / duration, 1);
        var eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
        valueEls.forEach(function (el) {
          render(el, eased);
        });
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    if (reduced) {
      valueEls.forEach(function (el) {
        render(el, 1);
      });
    } else {
      valueEls.forEach(function (el) {
        render(el, 0);
      });

      var counted = false;
      if ('IntersectionObserver' in window) {
        var statObserver = new IntersectionObserver(
          function (entries) {
            entries.forEach(function (entry) {
              if (!entry.isIntersecting || counted) return;
              counted = true;
              statObserver.disconnect();
              countUp();
            });
          },
          { threshold: 0.5 },
        );
        statObserver.observe(statsBand);
      } else {
        countUp();
      }
    }
  }

  /* ------------------------------------------------------- Scroll reveals */
  // The hidden state only exists under `html.js`, so no-JS keeps everything visible.
  var revealables = document.querySelectorAll('.reveal, .reveal-item');

  if (revealables.length && !reduced) {
    if ('IntersectionObserver' in window) {
      var revealObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            entry.target.classList.add('is-in');
            revealObserver.unobserve(entry.target);
          });
        },
        { threshold: 0.3 },
      );
      revealables.forEach(function (el) {
        revealObserver.observe(el);
      });
    } else {
      revealables.forEach(function (el) {
        el.classList.add('is-in');
      });
    }
  }
})();

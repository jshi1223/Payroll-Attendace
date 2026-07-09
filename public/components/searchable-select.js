function searchableSelectHTML(name, options, placeholder = 'Search employee...') {
  return `
    <div class="ss-wrapper" data-ss-name="${name}">
      <input type="text" class="ss-input" placeholder="${placeholder}" autocomplete="off" required>
      <input type="hidden" name="${name}" value="">
      <div class="ss-dropdown">
        ${options.length === 0 ? '<div class="ss-option disabled">No employees available</div>' : options.map((opt, i) =>
          `<div class="ss-option" data-value="${opt.value}" data-index="${i}">
            <span class="ss-opt-text">${escapeHtml(opt.label)}</span>
          </div>`
        ).join('')}
        <div class="ss-no-match" style="display:none">No match found</div>
      </div>
    </div>
  `;
}

function bindSearchableSelect(container) {
  if (!container) return;
  container.querySelectorAll('.ss-wrapper').forEach(wrapper => {
    const input = wrapper.querySelector('.ss-input');
    const hidden = wrapper.querySelector('input[type="hidden"]');
    const dropdown = wrapper.querySelector('.ss-dropdown');
    const options = wrapper.querySelectorAll('.ss-option:not(.disabled)');
    let selected = false;

    function filterOptions(query) {
      const lower = query.toLowerCase();
      let hasVisible = false;
      options.forEach(opt => {
        const text = opt.querySelector('.ss-opt-text').textContent.toLowerCase();
        const match = text.includes(lower);
        opt.style.display = match ? 'flex' : 'none';
        if (match) hasVisible = true;
      });
      return hasVisible;
    }

    function showDropdown() {
      dropdown.style.display = 'block';
      filterOptions(input.value.toLowerCase());
    }

    function hideDropdown() {
      setTimeout(() => {
        dropdown.style.display = 'none';
      }, 150);
    }

    input.addEventListener('focus', showDropdown);
    input.addEventListener('blur', hideDropdown);

    input.addEventListener('input', () => {
      const val = input.value;
      if (!selected) {
        hidden.value = '';
      }
      selected = false;
      dropdown.style.display = 'block';
      const hasVisible = filterOptions(val);
      const noMatch = wrapper.querySelector('.ss-no-match');
      if (noMatch) {
        noMatch.style.display = (!hasVisible && val.length > 0) ? 'flex' : 'none';
      }
    });

    options.forEach(opt => {
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const value = opt.dataset.value;
        const text = opt.querySelector('.ss-opt-text').textContent;
        hidden.value = value;
        input.value = text;
        selected = true;
        dropdown.style.display = 'none';
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        dropdown.style.display = 'none';
        input.blur();
      }
      if (e.key === 'Enter' && dropdown.style.display === 'block') {
        const visible = wrapper.querySelector('.ss-option[style*="display: flex"]');
        if (visible && !hidden.value) {
          visible.click();
          e.preventDefault();
        }
      }
    });

    input.addEventListener('change', () => {
      if (!input.value.trim()) {
        hidden.value = '';
        selected = false;
      }
    });
  });
}

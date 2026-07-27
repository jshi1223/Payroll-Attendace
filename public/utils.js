const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });

function moneyValue(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function formatMoney(value) {
  return peso.format(moneyValue(value));
}

function parseDateOnly(input) {
  if (input instanceof Date) return new Date(Date.UTC(input.getFullYear(), input.getMonth(), input.getDate()));
  if (typeof input === 'string' && input.includes('T')) {
    const d = new Date(input);
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }
  const value = typeof input === 'string' ? input.slice(0, 10) : todayInManila();
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateOnly(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function todayInManila() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function weekStartOf(input) {
  const date = parseDateOnly(input);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - day);
  return formatDateOnly(date);
}

function payrollWeekStartOf(input) {
  const date = parseDateOnly(input);
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + offset);
  return formatDateOnly(date);
}

function addDays(input, days) {
  const date = parseDateOnly(input);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

function daysBetween(dateA, dateB) {
  const a = parseDateOnly(dateA);
  const b = parseDateOnly(dateB);
  return Math.round((b - a) / 86400000);
}

const PERIOD_ANCHOR = '2020-01-06';

function periodStartOf(dateInput, periodDays = 7) {
  const monday = payrollWeekStartOf(dateInput);
  const diff = daysBetween(PERIOD_ANCHOR, monday);
  const periodIndex = Math.floor(diff / periodDays);
  return addDays(PERIOD_ANCHOR, periodIndex * periodDays);
}

function periodEndOf(dateInput, periodDays = 7) {
  return addDays(periodStartOf(dateInput, periodDays), periodDays - 1);
}

function getPeriodLabel(periodDays) {
  const labels = { 7: 'Weekly', 14: 'Semi-Monthly', 21: '3 Weeks', 30: 'Monthly' };
  return labels[periodDays] || `${periodDays}-day`;
}

function formatShortDate(dateInput) {
  const date = parseDateOnly(dateInput);
  const day = date.getUTCDate();
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${day}-${month}`;
}

function workdayNumber(dateInput, startOfWeek = weekStartOf) {
  const start = parseDateOnly(startOfWeek(dateInput));
  const date = parseDateOnly(dateInput);
  return Math.floor((date - start) / 86400000) + 1;
}

function payrollWorkdayNumber(dateInput) {
  return workdayNumber(dateInput, payrollWeekStartOf);
}

function workdayLabel(dateInput) {
  const date = parseDateOnly(dateInput);
  const dayName = date.toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return `${dayName} ${payrollWorkdayNumber(dateInput)}`;
}

function formatSlipDate(dateInput) {
  const date = parseDateOnly(dateInput);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const year = String(date.getUTCFullYear()).slice(2);
  return `${day}-${month}-${year}`;
}

function amountInWords(amount) {
  const pesos = Math.max(0, Math.round(Number(amount || 0)));
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const chunk = number => {
    let text = '';
    if (number >= 100) {
      text += `${ones[Math.floor(number / 100)]} Hundred`;
      number %= 100;
      if (number) text += ' ';
    }
    if (number >= 20) {
      text += tens[Math.floor(number / 10)];
      number %= 10;
      if (number) text += ` ${ones[number]}`;
    } else if (number > 0) {
      text += ones[number];
    }
    return text;
  };
  if (pesos === 0) return 'Zero Pesos';
  const parts = [];
  const millions = Math.floor(pesos / 1000000);
  const thousands = Math.floor((pesos % 1000000) / 1000);
  const remainder = pesos % 1000;
  if (millions) parts.push(`${chunk(millions)} Million`);
  if (thousands) parts.push(`${chunk(thousands)} Thousand`);
  if (remainder) parts.push(chunk(remainder));
  return `${parts.join(' ')} Pesos`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlight(value) {
  const text = escapeHtml(value);
  const view = state.view;
  const searchField = view === 'attendance' ? state.searchAttendance
    : view === 'employees' || view === 'archive' ? state.searchEmployees
    : state.searchPayroll;
  const query = (searchField || '').trim();
  if (!query) return text;
  return text.replace(new RegExp(`(${escapeRegex(query)})`, 'ig'), '<mark>$1</mark>');
}

function paginateRows(rows, page, pageSize = 50) {
  const totalPages = Math.ceil(rows.length / pageSize) || 1;
  const safePage = Math.min(Math.max(1, page || 1), totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    rows: rows.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    total: rows.length,
    from: start + 1,
    to: Math.min(start + pageSize, rows.length)
  };
}

function paginationHTML(pg, prefix) {
  if (pg.totalPages <= 1) return '';
  return `
    <div class="pagination">
      <button class="ghost" data-pg-prev="${prefix}" ${pg.page <= 1 ? 'disabled' : ''}>← Previous</button>
      <span>Page ${pg.page} of ${pg.totalPages} (${pg.total} records)</span>
      <button class="ghost" data-pg-next="${prefix}" ${pg.page >= pg.totalPages ? 'disabled' : ''}>Next →</button>
    </div>
  `;
}

function bindPagination(prefix, callback) {
  document.querySelector(`[data-pg-prev="${prefix}"]`)?.addEventListener('click', () => {
    state.pages[prefix] = Math.max(1, (state.pages[prefix] || 1) - 1);
    callback();
  });
  document.querySelector(`[data-pg-next="${prefix}"]`)?.addEventListener('click', () => {
    state.pages[prefix] = (state.pages[prefix] || 1) + 1;
    callback();
  });
}

function togglePassword(btn) {
  const input = btn.previousElementSibling;
  if (!input) return;
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  btn.textContent = isPassword ? 'HIDE' : 'SHOW';
}

function debounce(fn, wait) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

function loadingButton(button, isLoading) {
  if (!button) return;
  button.disabled = isLoading;
  if (isLoading) {
    button.dataset.originalText = button.textContent;
    button.innerHTML = '<span class="spinner"></span> Saving...';
  } else {
    button.innerHTML = button.dataset.originalText || button.innerHTML;
  }
}

function showToast(message, type = 'success') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'i';
  toast.innerHTML = `<span>${icon}</span> ${escapeHtml(message)}`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function exportCSV(data, filename) {
  if (!data || !data.length) {
    showToast('No data to export.', 'error');
    return;
  }
  const headers = Object.keys(data[0]);
  const csvContent = [
    headers.join(','),
    ...data.map(row => headers.map(h => {
      const val = String(row[h] ?? '');
      return val.includes(',') || val.includes('"') || val.includes('\n')
        ? `"${val.replace(/"/g, '""')}"`
        : val;
    }).join(','))
  ].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
  showToast('CSV exported successfully.');
}

function deleteButton(resource, id) {
  if (resource !== 'cash-advances' && resource !== 'extra-payments' && state.user.role !== 'admin') return '';
  const label = resource === 'employees' ? 'Archive' : 'Delete';
  return `<button class="danger" data-delete-resource="${resource}" data-delete-id="${id}">${label}</button>`;
}

function passwordToggleIcon(isVisible = false) {
  return isVisible
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A10.8 10.8 0 0 1 12 4c5.5 0 9.3 5.1 10 8-.3 1.2-1.1 2.8-2.5 4.1M6.6 6.6C4.5 8 2.7 10.4 2 12c.7 2.9 4.5 8 10 8 1.3 0 2.5-.3 3.6-.8"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-8 10-8 10 8 10 8-3.6 8-10 8S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
}

function bindPasswordToggles(container = document) {
  container.querySelectorAll('[data-password-toggle]').forEach(button => {
    button.addEventListener('click', () => {
      const input = button.closest('.password-wrapper')?.querySelector('input');
      if (!input) return;
      const isHidden = input.type === 'password';
      input.type = isHidden ? 'text' : 'password';
      button.innerHTML = passwordToggleIcon(isHidden);
      button.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
      button.setAttribute('aria-pressed', String(isHidden));
      input.focus();
    });
  });
}

function bindDeletes() {
  document.querySelectorAll('[data-delete-resource]').forEach(button => {
    button.addEventListener('click', async () => {
      state.pendingDelete = {
        resource: button.dataset.deleteResource,
        id: button.dataset.deleteId
      };
      reRenderCurrentView();
    });
  });
}

/* ── Modal Keyboard Helpers ── */
function getFocusable(container) {
  return container.querySelectorAll('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])');
}

function focusFirst(container) {
  const focusable = getFocusable(container);
  for (const el of focusable) {
    if (el.offsetParent !== null) {
      el.focus();
      break;
    }
  }
}

function setupModalKeyboard(modalSelector, closeCallback) {
  const modal = document.querySelector(modalSelector);
  if (!modal) return;
  setTimeout(() => focusFirst(modal), 50);
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeCallback();
    }
  });
}

function bindForm(selector, url) {
  document.querySelector(selector)?.addEventListener('submit', async event => {
    event.preventDefault();
    await api(url, {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))
    });
    reRenderCurrentView();
  });
}

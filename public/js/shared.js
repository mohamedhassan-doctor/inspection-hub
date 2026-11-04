// ── PWA install support ──
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }
})();

// ── Toast ──
function showToast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ── API wrapper ──
async function api(method, url, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'حدث خطأ');
  return data;
}

// ── Session & Sidebar init ──
let currentUser = null;

async function initPage(activeLink) {
  try {
    const data = await api('GET', '/api/session');
    currentUser = data;
    const nameEl = document.getElementById('user-name');
    if (nameEl) nameEl.textContent = data.name;

    // Mark active nav link
    document.querySelectorAll('.nav-link').forEach(a => {
      a.classList.remove('active');
      if (a.dataset.page === activeLink) a.classList.add('active');
    });

    // Hide admin-only elements for non-superadmin
    if (data.role !== 'superadmin') {
      document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
    }
    // Hide dept-admin elements for roles below quality_manager
    if (data.role !== 'superadmin' && data.role !== 'quality_manager') {
      document.querySelectorAll('.dept-admin').forEach(el => el.style.display = 'none');
    }
    // Hide quality-only elements for non-quality users
    const isQuality = data.role === 'superadmin' ||
      (data.department_name && data.department_name.includes('جودة'));
    if (!isQuality) {
      document.querySelectorAll('.quality-only').forEach(el => el.style.display = 'none');
    }
    // Hide checklists link for non-جودة users
    const canSeeChecklists = data.role === 'superadmin' ||
      (data.department_name && data.department_name.includes('جودة'));
    if (!canSeeChecklists) {
      document.querySelectorAll('a[href="/checklists"]').forEach(el => el.style.display = 'none');
    }

    // CAPA badge update
    updateCapaBadge();
    setInterval(updateCapaBadge, 5 * 60 * 1000);

    setupMobileSidebar();

  } catch {
    window.location.href = '/login';
  }
}

async function updateCapaBadge() {
  try {
    const d = await api('GET', '/api/capa/overdue-count');
    const badge = document.getElementById('capa-badge');
    if (!badge) return;
    if (d.count > 0) {
      badge.textContent = d.count;
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }
  } catch {}
}

// ── Confirm dialog ──
function confirmAction(msg) {
  return confirm(msg);
}

// ── Styled RTL delete-confirm dialog (Promise<boolean>; no HTML markup needed per page) ──
function confirmDelete({ title, itemName, warning } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal modal-sm" role="alertdialog" aria-modal="true">
        <div class="modal-header">
          <span class="modal-title"><i class="fas fa-trash" style="color:#ef4444;margin-left:8px"></i>${title || 'تأكيد الحذف'}</span>
          <button type="button" class="modal-close" data-action="cancel">&times;</button>
        </div>
        <div class="modal-body">
          ${itemName ? `<p style="margin:0 0 10px">"${itemName}"</p>` : ''}
          ${warning ? `<p style="margin:0;color:#b91c1c;font-size:13px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px">${warning}</p>` : ''}
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-action="cancel">إلغاء</button>
          <button type="button" class="btn btn-danger" data-action="confirm">حذف</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const cleanup = result => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
    const onKey = e => { if (e.key === 'Escape') cleanup(false); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', e => {
      if (e.target === overlay || e.target.closest('[data-action="cancel"]')) cleanup(false);
      else if (e.target.closest('[data-action="confirm"]')) cleanup(true);
    });
  });
}

// ── Format date ──
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Inspection type labels ──
const inspTypeLabels = {
  environmental_safety: 'السلامة البيئية',
  patient_safety: 'سلامة المريض',
  infection_control: 'مكافحة العدوى',
  fire_safety: 'سلامة الحريق',
  medication: 'الأدوية',
  medical_equipment: 'المعدات الطبية',
  facilities_infrastructure: 'المرافق والبنية التحتية',
  radiation_safety: 'السلامة الإشعاعية',
  lab_safety: 'سلامة المعمل',
  surgical_safety: 'السلامة الجراحية',
  communication_safety: 'سلامة التواصل',
  comprehensive_multidisciplinary: 'جولة شاملة متعددة التخصصات',
};

// ── Status labels ──
const statusLabels = {
  scheduled: { text: 'مجدولة', cls: 'badge-info' },
  in_progress: { text: 'جارية', cls: 'badge-warning' },
  completed: { text: 'مكتملة', cls: 'badge-success' },
  cancelled: { text: 'ملغاة', cls: 'badge-secondary' },
};

// ── CAPA status labels ──
const capaStatusLabels = {
  open: { text: 'مفتوحة', cls: 'badge-info' },
  in_progress: { text: 'جارية', cls: 'badge-warning' },
  closed: { text: 'مغلقة', cls: 'badge-success' },
  overdue: { text: 'متأخرة', cls: 'badge-danger' },
};

// ── Severity labels ──
const sevLabels = {
  critical: { text: 'حرجة', cls: 'badge sev-critical' },
  major: { text: 'رئيسية', cls: 'badge sev-major' },
  observation: { text: 'ملاحظة', cls: 'badge sev-observation' },
};

// ── Result labels ──
const resultLabels = {
  compliant: { text: 'مطابق', cls: 'badge-success' },
  non_compliant: { text: 'غير مطابق', cls: 'badge-danger' },
  needs_improvement: { text: 'يحتاج تحسين', cls: 'badge-warning' },
  not_applicable: { text: 'غير قابل للتطبيق', cls: 'badge-secondary' },
};

// ── Role labels ──
const roleLabels = {
  superadmin: 'مدير النظام',
  quality_manager: 'مدير الجودة',
  quality_staff: 'موظف الجودة',
};

function complianceColor(pct) {
  if (pct >= 85) return 'green';
  if (pct >= 70) return 'yellow';
  return 'red';
}

function complianceBadgeClass(pct) {
  if (pct >= 85) return 'badge-success';
  if (pct >= 70) return 'badge-warning';
  return 'badge-danger';
}

// ── Mobile sidebar ──
function setupMobileSidebar() {
  if (!document.querySelector('.sidebar')) return;

  const overlay = document.createElement('div');
  overlay.className = 'mob-overlay';
  overlay.id = 'mob-overlay';
  overlay.addEventListener('click', closeMobileSidebar);
  document.body.appendChild(overlay);

  const btn = document.createElement('button');
  btn.className = 'mob-hamburger';
  btn.id = 'mob-hamburger';
  btn.setAttribute('aria-label', 'القائمة');
  btn.innerHTML = '<i class="fas fa-bars"></i>';
  btn.addEventListener('click', toggleMobileSidebar);
  document.body.appendChild(btn);

  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', closeMobileSidebar);
  });
}

function toggleMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('mob-overlay');
  const btn = document.getElementById('mob-hamburger');
  const isOpen = sidebar.classList.contains('mobile-open');
  sidebar.classList.toggle('mobile-open', !isOpen);
  overlay.classList.toggle('open', !isOpen);
  btn.innerHTML = isOpen ? '<i class="fas fa-bars"></i>' : '<i class="fas fa-times"></i>';
}

function closeMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('mob-overlay');
  const btn = document.getElementById('mob-hamburger');
  if (!sidebar) return;
  sidebar.classList.remove('mobile-open');
  if (overlay) overlay.classList.remove('open');
  if (btn) btn.innerHTML = '<i class="fas fa-bars"></i>';
}

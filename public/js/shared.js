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

    // CAPA badge update
    updateCapaBadge();
    setInterval(updateCapaBadge, 5 * 60 * 1000);

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

// ── Format date ──
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Inspection type labels ──
const inspTypeLabels = {
  safety: 'السلامة العامة',
  infection_control: 'مكافحة العدوى',
  fire_safety: 'سلامة الحريق',
  cleanliness: 'النظافة',
  medication: 'الأدوية',
  patient_files: 'ملفات المرضى',
  equipment: 'المعدات',
  gahar_prep: 'تحضير GAHAR',
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
  dept_head: 'رئيس قسم',
  inspector: 'مفتش',
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

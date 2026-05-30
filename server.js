require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Middleware ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'inspection-hub-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'تجاوزت الحد المسموح به. حاول مرة أخرى بعد 15 دقيقة.' },
});

// ── Auth helpers ──
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.redirect('/login');
  next();
};

const requireAuthAPI = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'غير مصرح' });
  next();
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'غير مصرح' });
  if (!roles.includes(req.session.role)) return res.status(403).json({ error: 'ليس لديك صلاحية' });
  next();
};

// ── HTML helper ──
const serveHTML = (filename) => (req, res) => {
  fs.readFile(path.join(__dirname, 'public', filename), 'utf8', (err, data) => {
    if (err) return res.status(500).send('خطأ في الخادم');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(data);
  });
};

// ── Audit log ──
async function audit(userId, action, details) {
  try {
    await pool.query('INSERT INTO audit_log(user_id,action,details) VALUES($1,$2,$3)', [userId, action, details]);
  } catch {}
}

// ── Compliance calculation ──
async function calcCompliance(inspectionId) {
  const r = await pool.query(
    `SELECT
       COUNT(CASE WHEN result='compliant' THEN 1 END)::int AS compliant,
       COUNT(CASE WHEN result IS NOT NULL AND result!='not_applicable' THEN 1 END)::int AS total
     FROM inspection_items WHERE inspection_id=$1`,
    [inspectionId]
  );
  const { compliant, total } = r.rows[0];
  if (!total) return 0;
  return Math.round((compliant / total) * 100 * 10) / 10;
}

// ── DB Init ──
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'inspector'
    );

    CREATE TABLE IF NOT EXISTS departments (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checklist_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      dept_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS checklist_items (
      id SERIAL PRIMARY KEY,
      template_id INTEGER REFERENCES checklist_templates(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      gahar_ref TEXT,
      order_num INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS inspections (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      dept_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      inspector_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      scheduled_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      compliance_score NUMERIC(5,1),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inspection_items (
      id SERIAL PRIMARY KEY,
      inspection_id INTEGER REFERENCES inspections(id) ON DELETE CASCADE,
      item_text TEXT NOT NULL,
      gahar_ref TEXT,
      result TEXT,
      notes TEXT,
      photo_url TEXT
    );

    CREATE TABLE IF NOT EXISTS findings (
      id SERIAL PRIMARY KEY,
      inspection_id INTEGER REFERENCES inspections(id) ON DELETE SET NULL,
      item_id INTEGER REFERENCES inspection_items(id) ON DELETE SET NULL,
      dept_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      severity TEXT NOT NULL,
      description TEXT NOT NULL,
      photo_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS capas (
      id SERIAL PRIMARY KEY,
      finding_id INTEGER REFERENCES findings(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      responsible_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      due_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      evidence_notes TEXT,
      closed_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS capa_reminders (
      id SERIAL PRIMARY KEY,
      capa_id INTEGER REFERENCES capas(id) ON DELETE CASCADE,
      remind_at TIMESTAMP NOT NULL,
      sent BOOLEAN DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Seed if empty
  const { rows: uRows } = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(uRows[0].count) > 0) return;

  const hash = await bcrypt.hash('admin123', 10);
  await pool.query(
    "INSERT INTO users(name,username,password,role) VALUES($1,$2,$3,$4)",
    ['مدير النظام', 'admin', hash, 'superadmin']
  );

  const depts = ['الطوارئ','الباطنة','الجراحة','العمليات','العناية المركزة','الصيدلية','المختبر','الأشعة','التمريض','الإدارة'];
  for (const d of depts) {
    await pool.query('INSERT INTO departments(name) VALUES($1)', [d]);
  }

  // Emergency checklist
  const { rows: [d1] } = await pool.query("SELECT id FROM departments WHERE name='الطوارئ'");
  const { rows: [t1] } = await pool.query(
    "INSERT INTO checklist_templates(name,dept_id) VALUES($1,$2) RETURNING id",
    ['قائمة تدقيق الطوارئ', d1.id]
  );
  const emergencyItems = [
    ['توافر معدات الإنعاش القلبي الرئوي في الطوارئ', 'FMS.1'],
    ['صلاحية أدوية الطوارئ وعدم انتهاء صلاحيتها', 'MM.1'],
    ['تطبيق بروتوكول الفرز (Triage) بشكل صحيح', 'ACC.4'],
    ['توثيق ملفات المرضى بشكل كامل', 'MR.1'],
    ['وجود لوائح إرشادية واضحة بالطوارئ', 'PFR.2'],
    ['نظافة المنطقة والمعدات', 'IC.3'],
    ['إجراءات الحد من العدوى معمول بها', 'IC.1'],
    ['توافر PPE واستخدامها الصحيح', 'IC.2'],
    ['التحقق من هوية المريض قبل الإجراءات', 'IPSG.1'],
    ['توثيق الدواء وإعطاؤه بشكل صحيح', 'IPSG.3'],
  ];
  for (let i = 0; i < emergencyItems.length; i++) {
    await pool.query(
      'INSERT INTO checklist_items(template_id,text,gahar_ref,order_num) VALUES($1,$2,$3,$4)',
      [t1.id, emergencyItems[i][0], emergencyItems[i][1], i + 1]
    );
  }

  // Infection control checklist
  const { rows: [d2] } = await pool.query("SELECT id FROM departments WHERE name='التمريض'");
  const { rows: [t2] } = await pool.query(
    "INSERT INTO checklist_templates(name,dept_id) VALUES($1,$2) RETURNING id",
    ['قائمة تدقيق مكافحة العدوى', d2.id]
  );
  const icItems = [
    ['غسل الأيدي قبل وبعد التعامل مع المريض', 'IC.1'],
    ['التخلص الصحيح من النفايات الطبية', 'FMS.5'],
    ['استخدام معدات الوقاية الشخصية المناسبة', 'IC.2'],
    ['تعقيم وتطهير الأسطح والمعدات', 'IC.3'],
    ['عزل المرضى ذوي الأمراض المعدية', 'IC.5'],
    ['تنفيذ بروتوكول الإبر الحادة بشكل صحيح', 'IC.4'],
    ['مراقبة معدلات العدوى وتوثيقها', 'IC.6'],
    ['تدريب الموظفين على بروتوكولات مكافحة العدوى', 'IC.8'],
  ];
  for (let i = 0; i < icItems.length; i++) {
    await pool.query(
      'INSERT INTO checklist_items(template_id,text,gahar_ref,order_num) VALUES($1,$2,$3,$4)',
      [t2.id, icItems[i][0], icItems[i][1], i + 1]
    );
  }

  // Sample completed inspection (75% compliance)
  const { rows: [admin] } = await pool.query("SELECT id FROM users WHERE username='admin'");
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const { rows: [insp] } = await pool.query(
    "INSERT INTO inspections(title,type,dept_id,inspector_id,scheduled_date,status) VALUES($1,$2,$3,$4,$5,'completed') RETURNING id",
    ['جولة سلامة الطوارئ - مايو', 'safety', d1.id, admin.id, twoWeeksAgo.toISOString().split('T')[0]]
  );
  const sampleResults = [
    ['compliant', null], ['compliant', null], ['compliant', null], ['compliant', null],
    ['compliant', null], ['compliant', null], ['non_compliant', 'يحتاج تجديد عاجل'],
    ['non_compliant', 'لم يتم التوثيق'], ['not_applicable', null], ['not_applicable', null],
  ];
  // 6 compliant / 8 answered = 75%
  for (let i = 0; i < emergencyItems.length; i++) {
    await pool.query(
      "INSERT INTO inspection_items(inspection_id,item_text,gahar_ref,result,notes) VALUES($1,$2,$3,$4,$5)",
      [insp.id, emergencyItems[i][0], emergencyItems[i][1], sampleResults[i][0], sampleResults[i][1]]
    );
  }
  await pool.query("UPDATE inspections SET compliance_score=75 WHERE id=$1", [insp.id]);

  // Sample finding from the inspection
  const { rows: [nc1] } = await pool.query(
    "SELECT id FROM inspection_items WHERE inspection_id=$1 AND result='non_compliant' LIMIT 1",
    [insp.id]
  );
  const { rows: [finding] } = await pool.query(
    "INSERT INTO findings(inspection_id,item_id,dept_id,severity,description) VALUES($1,$2,$3,$4,$5) RETURNING id",
    [insp.id, nc1.id, d1.id, 'major', 'يحتاج تجديد عاجل — تم رصد انتهاء صلاحية بعض الأدوية']
  );

  // Sample CAPA for the finding
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 7);
  const { rows: [capa] } = await pool.query(
    "INSERT INTO capas(finding_id,action,responsible_id,due_date,status) VALUES($1,$2,$3,$4,'open') RETURNING id",
    [finding.id, 'مراجعة وتجديد جميع أدوية الطوارئ المنتهية الصلاحية', admin.id, dueDate.toISOString().split('T')[0]]
  );
  const remindAt = new Date(dueDate);
  remindAt.setDate(remindAt.getDate() - 3);
  await pool.query("INSERT INTO capa_reminders(capa_id,remind_at) VALUES($1,$2)", [capa.id, remindAt.toISOString()]);

  console.log('✓ Seed data inserted');
}

// ══════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  serveHTML('login.html')(req, res);
});

app.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (!rows.length) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.name = user.name;
    await audit(user.id, 'login', `دخول المستخدم ${user.username}`);
    res.json({ ok: true, role: user.role });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ══════════════════════════════════
//  PAGE ROUTES
// ══════════════════════════════════
app.get('/', requireAuth, serveHTML('index.html'));
app.get('/inspections', requireAuth, serveHTML('inspections.html'));
app.get('/checklists', requireAuth, serveHTML('checklists.html'));
app.get('/findings', requireAuth, serveHTML('findings.html'));
app.get('/capa', requireAuth, serveHTML('capa.html'));
app.get('/reports', requireAuth, serveHTML('reports.html'));
app.get('/users', requireAuth, requireRole('superadmin'), serveHTML('users.html'));

// ══════════════════════════════════
//  API — SESSION
// ══════════════════════════════════
app.get('/api/session', requireAuthAPI, (req, res) => {
  res.json({ id: req.session.userId, role: req.session.role, name: req.session.name });
});

// ══════════════════════════════════
//  API — DEPARTMENTS
// ══════════════════════════════════
app.get('/api/departments', requireAuthAPI, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM departments ORDER BY id');
  res.json(rows);
});

// ══════════════════════════════════
//  API — DASHBOARD
// ══════════════════════════════════
app.get('/api/dashboard/stats', requireAuthAPI, async (req, res) => {
  try {
    const [r1, r2, r3, r4] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM inspections WHERE DATE_TRUNC('month',scheduled_date)=DATE_TRUNC('month',CURRENT_DATE)`),
      pool.query(`SELECT ROUND(AVG(compliance_score),1) AS avg FROM inspections WHERE status='completed' AND DATE_TRUNC('month',scheduled_date)=DATE_TRUNC('month',CURRENT_DATE)`),
      pool.query(`SELECT COUNT(DISTINCT f.id) AS cnt FROM findings f LEFT JOIN capas c ON c.finding_id=f.id WHERE c.id IS NULL OR c.status!='closed'`),
      pool.query(`SELECT COUNT(*) FROM capas WHERE status='overdue'`),
    ]);
    res.json({
      total: parseInt(r1.rows[0].count),
      avg_compliance: parseFloat(r2.rows[0].avg) || 0,
      open_findings: parseInt(r3.rows[0].cnt),
      overdue_capas: parseInt(r4.rows[0].count),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/dashboard/departments', requireAuthAPI, async (req, res) => {
  try {
    const month = req.query.month; // format: YYYY-MM
    let dateFilter = `DATE_TRUNC('month',i.scheduled_date)=DATE_TRUNC('month',CURRENT_DATE)`;
    const params = [];
    if (month) {
      dateFilter = `DATE_TRUNC('month',i.scheduled_date)=DATE_TRUNC('month',$1::date)`;
      params.push(month + '-01');
    }

    const q = `
      WITH scores AS (
        SELECT i.dept_id, i.id,
          CASE WHEN COUNT(CASE WHEN ii.result IS NOT NULL AND ii.result!='not_applicable' THEN 1 END)>0
            THEN ROUND(COUNT(CASE WHEN ii.result='compliant' THEN 1 END)*100.0/
              NULLIF(COUNT(CASE WHEN ii.result IS NOT NULL AND ii.result!='not_applicable' THEN 1 END),0),1)
            ELSE 0 END AS compliance
        FROM inspections i
        LEFT JOIN inspection_items ii ON ii.inspection_id=i.id
        WHERE i.status='completed' AND ${dateFilter}
        GROUP BY i.dept_id, i.id
      )
      SELECT d.id, d.name,
        COUNT(s.id)::int AS inspection_count,
        COALESCE(ROUND(AVG(s.compliance),1),0) AS avg_compliance
      FROM departments d
      LEFT JOIN scores s ON s.dept_id=d.id
      GROUP BY d.id, d.name
      ORDER BY d.name
    `;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/dashboard/recent', requireAuthAPI, async (req, res) => {
  try {
    const [r1, r2] = await Promise.all([
      pool.query(`
        SELECT i.id, i.title, i.type, i.scheduled_date, i.status, i.compliance_score, d.name AS dept_name
        FROM inspections i LEFT JOIN departments d ON d.id=i.dept_id
        ORDER BY i.created_at DESC LIMIT 5
      `),
      pool.query(`
        SELECT c.id, c.action, c.due_date, c.status, u.name AS responsible,
          d.name AS dept_name, f.severity
        FROM capas c
        LEFT JOIN findings f ON f.id=c.finding_id
        LEFT JOIN departments d ON d.id=f.dept_id
        LEFT JOIN users u ON u.id=c.responsible_id
        WHERE c.status='overdue'
        ORDER BY c.due_date ASC LIMIT 5
      `),
    ]);
    res.json({ inspections: r1.rows, overdue_capas: r2.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

// ══════════════════════════════════
//  API — INSPECTIONS
// ══════════════════════════════════
app.get('/api/inspections', requireAuthAPI, async (req, res) => {
  try {
    const { dept, type, status, date } = req.query;
    let where = ['1=1'];
    const params = [];
    if (dept) { params.push(dept); where.push(`i.dept_id=$${params.length}`); }
    if (type) { params.push(type); where.push(`i.type=$${params.length}`); }
    if (status) { params.push(status); where.push(`i.status=$${params.length}`); }
    if (date) { params.push(date); where.push(`DATE_TRUNC('month',i.scheduled_date)=DATE_TRUNC('month',$${params.length}::date)`); }

    const { rows } = await pool.query(`
      SELECT i.*, d.name AS dept_name, u.name AS inspector_name
      FROM inspections i
      LEFT JOIN departments d ON d.id=i.dept_id
      LEFT JOIN users u ON u.id=i.inspector_id
      WHERE ${where.join(' AND ')}
      ORDER BY i.scheduled_date DESC, i.created_at DESC
    `, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/inspections', requireAuthAPI, async (req, res) => {
  try {
    const { title, type, dept_id, inspector_id, scheduled_date, template_id } = req.body;
    const { rows: [insp] } = await pool.query(
      "INSERT INTO inspections(title,type,dept_id,inspector_id,scheduled_date,status) VALUES($1,$2,$3,$4,$5,'scheduled') RETURNING *",
      [title, type, dept_id, inspector_id || req.session.userId, scheduled_date]
    );
    if (template_id) {
      const { rows: items } = await pool.query(
        "SELECT * FROM checklist_items WHERE template_id=$1 AND active=true ORDER BY order_num",
        [template_id]
      );
      for (const item of items) {
        await pool.query(
          "INSERT INTO inspection_items(inspection_id,item_text,gahar_ref) VALUES($1,$2,$3)",
          [insp.id, item.text, item.gahar_ref]
        );
      }
    }
    await audit(req.session.userId, 'create_inspection', `جولة جديدة: ${title}`);
    res.json(insp);
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في الإنشاء' }); }
});

app.get('/api/inspections/:id', requireAuthAPI, async (req, res) => {
  try {
    const { rows: [insp] } = await pool.query(
      "SELECT i.*, d.name AS dept_name, u.name AS inspector_name FROM inspections i LEFT JOIN departments d ON d.id=i.dept_id LEFT JOIN users u ON u.id=i.inspector_id WHERE i.id=$1",
      [req.params.id]
    );
    if (!insp) return res.status(404).json({ error: 'غير موجود' });
    res.json(insp);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.put('/api/inspections/:id', requireAuthAPI, async (req, res) => {
  try {
    const { title, type, dept_id, inspector_id, scheduled_date, status } = req.body;
    const { rows: [insp] } = await pool.query(
      "UPDATE inspections SET title=$1,type=$2,dept_id=$3,inspector_id=$4,scheduled_date=$5,status=$6 WHERE id=$7 RETURNING *",
      [title, type, dept_id, inspector_id, scheduled_date, status, req.params.id]
    );
    res.json(insp);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.delete('/api/inspections/:id', requireAuthAPI, requireRole('superadmin', 'quality_manager'), async (req, res) => {
  try {
    await pool.query("DELETE FROM inspections WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/inspections/:id/items', requireAuthAPI, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM inspection_items WHERE inspection_id=$1 ORDER BY id",
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.put('/api/inspections/:id/items/:itemId', requireAuthAPI, async (req, res) => {
  try {
    const { result, notes } = req.body;
    const { rows: [item] } = await pool.query(
      "UPDATE inspection_items SET result=$1,notes=$2 WHERE id=$3 AND inspection_id=$4 RETURNING *",
      [result, notes, req.params.itemId, req.params.id]
    );
    res.json(item);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/inspections/:id/start', requireAuthAPI, async (req, res) => {
  try {
    await pool.query("UPDATE inspections SET status='in_progress' WHERE id=$1 AND status='scheduled'", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/inspections/:id/complete', requireAuthAPI, async (req, res) => {
  try {
    const score = await calcCompliance(req.params.id);
    await pool.query(
      "UPDATE inspections SET status='completed', compliance_score=$1 WHERE id=$2",
      [score, req.params.id]
    );
    await audit(req.session.userId, 'complete_inspection', `إنهاء الجولة #${req.params.id} - نسبة المطابقة: ${score}%`);
    res.json({ ok: true, compliance_score: score });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/inspections/:id/report', requireAuthAPI, async (req, res) => {
  try {
    const { rows: [insp] } = await pool.query(
      "SELECT i.*, d.name AS dept_name, u.name AS inspector_name FROM inspections i LEFT JOIN departments d ON d.id=i.dept_id LEFT JOIN users u ON u.id=i.inspector_id WHERE i.id=$1",
      [req.params.id]
    );
    if (!insp) return res.status(404).json({ error: 'غير موجود' });
    const { rows: items } = await pool.query(
      "SELECT * FROM inspection_items WHERE inspection_id=$1 ORDER BY id",
      [req.params.id]
    );
    const { rows: findings } = await pool.query(
      "SELECT f.*, ii.item_text FROM findings f LEFT JOIN inspection_items ii ON ii.id=f.item_id WHERE f.inspection_id=$1",
      [req.params.id]
    );
    res.json({ inspection: insp, items, findings });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

// Photo upload for inspection item (if Cloudinary configured)
app.post('/api/inspections/:id/items/:itemId/photo', requireAuthAPI, async (req, res) => {
  try {
    // Only available if Cloudinary is configured
    if (!process.env.CLOUDINARY_API_KEY) return res.status(400).json({ error: 'Cloudinary غير مهيأ' });
    const { upload } = require('./cloudinary');
    upload.single('photo')(req, res, async (err) => {
      if (err) return res.status(500).json({ error: 'فشل رفع الصورة' });
      if (!req.file) return res.status(400).json({ error: 'لا توجد صورة' });
      await pool.query(
        "UPDATE inspection_items SET photo_url=$1 WHERE id=$2 AND inspection_id=$3",
        [req.file.path, req.params.itemId, req.params.id]
      );
      res.json({ url: req.file.path });
    });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

// ══════════════════════════════════
//  API — CHECKLISTS
// ══════════════════════════════════
app.get('/api/checklists', requireAuthAPI, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT t.*, d.name AS dept_name, COUNT(i.id)::int AS item_count FROM checklist_templates t LEFT JOIN departments d ON d.id=t.dept_id LEFT JOIN checklist_items i ON i.template_id=t.id GROUP BY t.id,d.name ORDER BY t.created_at DESC"
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/checklists', requireAuthAPI, requireRole('superadmin', 'quality_manager'), async (req, res) => {
  try {
    const { name, dept_id } = req.body;
    const { rows: [t] } = await pool.query(
      "INSERT INTO checklist_templates(name,dept_id) VALUES($1,$2) RETURNING *",
      [name, dept_id || null]
    );
    res.json(t);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.put('/api/checklists/:id', requireAuthAPI, requireRole('superadmin', 'quality_manager'), async (req, res) => {
  try {
    const { name, dept_id } = req.body;
    const { rows: [t] } = await pool.query(
      "UPDATE checklist_templates SET name=$1,dept_id=$2 WHERE id=$3 RETURNING *",
      [name, dept_id || null, req.params.id]
    );
    res.json(t);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.delete('/api/checklists/:id', requireAuthAPI, requireRole('superadmin', 'quality_manager'), async (req, res) => {
  try {
    await pool.query("DELETE FROM checklist_templates WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/checklists/:id/items', requireAuthAPI, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM checklist_items WHERE template_id=$1 ORDER BY order_num, id",
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/checklists/:id/items', requireAuthAPI, requireRole('superadmin', 'quality_manager'), async (req, res) => {
  try {
    const { text, gahar_ref, order_num } = req.body;
    const { rows: [maxR] } = await pool.query("SELECT COALESCE(MAX(order_num),0) AS mx FROM checklist_items WHERE template_id=$1", [req.params.id]);
    const ord = order_num || (maxR.mx + 1);
    const { rows: [item] } = await pool.query(
      "INSERT INTO checklist_items(template_id,text,gahar_ref,order_num) VALUES($1,$2,$3,$4) RETURNING *",
      [req.params.id, text, gahar_ref || null, ord]
    );
    res.json(item);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.put('/api/checklists/:id/items/:itemId', requireAuthAPI, requireRole('superadmin', 'quality_manager'), async (req, res) => {
  try {
    const { text, gahar_ref, order_num, active } = req.body;
    const fields = [];
    const vals = [];
    if (text !== undefined) { vals.push(text); fields.push(`text=$${vals.length}`); }
    if (gahar_ref !== undefined) { vals.push(gahar_ref); fields.push(`gahar_ref=$${vals.length}`); }
    if (order_num !== undefined) { vals.push(order_num); fields.push(`order_num=$${vals.length}`); }
    if (active !== undefined) { vals.push(active); fields.push(`active=$${vals.length}`); }
    vals.push(req.params.itemId);
    const { rows: [item] } = await pool.query(
      `UPDATE checklist_items SET ${fields.join(',')} WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    res.json(item);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.delete('/api/checklists/:id/items/:itemId', requireAuthAPI, requireRole('superadmin', 'quality_manager'), async (req, res) => {
  try {
    await pool.query("DELETE FROM checklist_items WHERE id=$1", [req.params.itemId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

// ══════════════════════════════════
//  API — FINDINGS
// ══════════════════════════════════
app.get('/api/findings', requireAuthAPI, async (req, res) => {
  try {
    const { severity, dept, status } = req.query;
    let where = ['1=1'];
    const params = [];
    if (severity) { params.push(severity); where.push(`f.severity=$${params.length}`); }
    if (dept) { params.push(dept); where.push(`f.dept_id=$${params.length}`); }
    if (status === 'open') where.push(`(c.id IS NULL OR c.status!='closed')`);
    if (status === 'closed') where.push(`c.status='closed'`);

    const { rows } = await pool.query(`
      SELECT f.*, d.name AS dept_name,
        i.title AS inspection_title,
        c.id AS capa_id, c.status AS capa_status
      FROM findings f
      LEFT JOIN departments d ON d.id=f.dept_id
      LEFT JOIN inspections i ON i.id=f.inspection_id
      LEFT JOIN capas c ON c.finding_id=f.id
      WHERE ${where.join(' AND ')}
      ORDER BY f.created_at DESC
    `, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/findings', requireAuthAPI, async (req, res) => {
  try {
    const { inspection_id, item_id, dept_id, severity, description } = req.body;
    const { rows: [f] } = await pool.query(
      "INSERT INTO findings(inspection_id,item_id,dept_id,severity,description) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [inspection_id || null, item_id || null, dept_id, severity, description]
    );
    await audit(req.session.userId, 'create_finding', `مخالفة جديدة: ${description.slice(0,60)}`);
    res.json(f);
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.put('/api/findings/:id', requireAuthAPI, async (req, res) => {
  try {
    const { severity, description } = req.body;
    const { rows: [f] } = await pool.query(
      "UPDATE findings SET severity=$1,description=$2 WHERE id=$3 RETURNING *",
      [severity, description, req.params.id]
    );
    res.json(f);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.delete('/api/findings/:id', requireAuthAPI, requireRole('superadmin', 'quality_manager'), async (req, res) => {
  try {
    await pool.query("DELETE FROM findings WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

// ══════════════════════════════════
//  API — CAPA
// ══════════════════════════════════
app.get('/api/capa/overdue-count', requireAuthAPI, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT COUNT(*) FROM capas WHERE status='overdue'");
    res.json({ count: parseInt(rows[0].count) });
  } catch { res.json({ count: 0 }); }
});

app.get('/api/capa', requireAuthAPI, async (req, res) => {
  try {
    const { status, dept } = req.query;
    let where = ['1=1'];
    const params = [];
    if (status) { params.push(status); where.push(`c.status=$${params.length}`); }
    if (dept) { params.push(dept); where.push(`f.dept_id=$${params.length}`); }

    const { rows } = await pool.query(`
      SELECT c.*, u.name AS responsible_name,
        f.severity AS finding_severity, f.description AS finding_desc,
        d.name AS dept_name
      FROM capas c
      LEFT JOIN findings f ON f.id=c.finding_id
      LEFT JOIN departments d ON d.id=f.dept_id
      LEFT JOIN users u ON u.id=c.responsible_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.status='overdue' DESC, c.due_date ASC
    `, params);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/capa', requireAuthAPI, async (req, res) => {
  try {
    const { finding_id, action, responsible_id, due_date, evidence_notes } = req.body;
    const { rows: [c] } = await pool.query(
      "INSERT INTO capas(finding_id,action,responsible_id,due_date,status,evidence_notes) VALUES($1,$2,$3,$4,'open',$5) RETURNING *",
      [finding_id, action, responsible_id || null, due_date, evidence_notes || null]
    );
    // Reminder 3 days before due date
    const remindAt = new Date(due_date);
    remindAt.setDate(remindAt.getDate() - 3);
    await pool.query("INSERT INTO capa_reminders(capa_id,remind_at) VALUES($1,$2)", [c.id, remindAt.toISOString()]);
    await audit(req.session.userId, 'create_capa', `CAPA جديدة: ${action.slice(0,60)}`);
    res.json(c);
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.put('/api/capa/:id', requireAuthAPI, async (req, res) => {
  try {
    const { action, responsible_id, due_date, status, evidence_notes } = req.body;
    const closed_at = status === 'closed' ? new Date().toISOString() : null;
    const { rows: [c] } = await pool.query(
      "UPDATE capas SET action=$1,responsible_id=$2,due_date=$3,status=$4,evidence_notes=$5,closed_at=$6 WHERE id=$7 RETURNING *",
      [action, responsible_id || null, due_date, status, evidence_notes || null, closed_at, req.params.id]
    );
    if (status === 'closed') await audit(req.session.userId, 'close_capa', `إغلاق CAPA #${req.params.id}`);
    res.json(c);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.delete('/api/capa/:id', requireAuthAPI, requireRole('superadmin', 'quality_manager'), async (req, res) => {
  try {
    await pool.query("DELETE FROM capas WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

// ══════════════════════════════════
//  API — REPORTS
// ══════════════════════════════════
app.get('/api/reports/compliance', requireAuthAPI, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH scores AS (
        SELECT i.dept_id, i.id,
          CASE WHEN COUNT(CASE WHEN ii.result IS NOT NULL AND ii.result!='not_applicable' THEN 1 END)>0
            THEN ROUND(COUNT(CASE WHEN ii.result='compliant' THEN 1 END)*100.0/
              NULLIF(COUNT(CASE WHEN ii.result IS NOT NULL AND ii.result!='not_applicable' THEN 1 END),0),1)
            ELSE 0 END AS compliance
        FROM inspections i
        LEFT JOIN inspection_items ii ON ii.inspection_id=i.id
        WHERE i.status='completed'
        GROUP BY i.dept_id, i.id
      )
      SELECT d.name, COALESCE(ROUND(AVG(s.compliance),1),0) AS avg_compliance, COUNT(s.id)::int AS count
      FROM departments d
      LEFT JOIN scores s ON s.dept_id=d.id
      GROUP BY d.id, d.name ORDER BY avg_compliance DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/reports/pareto', requireAuthAPI, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ii.item_text, COUNT(*)::int AS frequency, f.severity
      FROM findings f
      LEFT JOIN inspection_items ii ON ii.id=f.item_id
      GROUP BY ii.item_text, f.severity
      ORDER BY frequency DESC
      LIMIT 10
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/reports/capa-rate', requireAuthAPI, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(CASE WHEN status='closed' THEN 1 END)::int AS closed,
        COUNT(CASE WHEN status='overdue' THEN 1 END)::int AS overdue,
        COUNT(CASE WHEN status='open' OR status='in_progress' THEN 1 END)::int AS open
      FROM capas
    `);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/reports/monthly', requireAuthAPI, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month',scheduled_date),'YYYY-MM') AS month,
        d.name AS dept_name,
        ROUND(AVG(compliance_score),1) AS avg_compliance,
        COUNT(*)::int AS count
      FROM inspections i
      LEFT JOIN departments d ON d.id=i.dept_id
      WHERE i.status='completed' AND scheduled_date >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month',scheduled_date), d.name
      ORDER BY month, dept_name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/reports/export', requireAuthAPI, async (req, res) => {
  try {
    const [r1, r2, r3] = await Promise.all([
      pool.query(`SELECT i.title, i.type, d.name AS dept, i.scheduled_date, i.status, i.compliance_score, u.name AS inspector FROM inspections i LEFT JOIN departments d ON d.id=i.dept_id LEFT JOIN users u ON u.id=i.inspector_id ORDER BY i.scheduled_date DESC`),
      pool.query(`SELECT f.description, f.severity, d.name AS dept, i.title AS inspection, f.created_at FROM findings f LEFT JOIN departments d ON d.id=f.dept_id LEFT JOIN inspections i ON i.id=f.inspection_id ORDER BY f.created_at DESC`),
      pool.query(`SELECT c.action, c.due_date, c.status, u.name AS responsible, f.description AS finding FROM capas c LEFT JOIN users u ON u.id=c.responsible_id LEFT JOIN findings f ON f.id=c.finding_id ORDER BY c.due_date`),
    ]);

    const wb = XLSX.utils.book_new();

    const ws1 = XLSX.utils.json_to_sheet(r1.rows.map(r => ({
      'العنوان': r.title, 'النوع': r.type, 'القسم': r.dept,
      'التاريخ': r.scheduled_date, 'الحالة': r.status, 'نسبة المطابقة': r.compliance_score, 'المفتش': r.inspector,
    })));
    XLSX.utils.book_append_sheet(wb, ws1, 'الجولات');

    const ws2 = XLSX.utils.json_to_sheet(r2.rows.map(r => ({
      'الوصف': r.description, 'الخطورة': r.severity, 'القسم': r.dept, 'الجولة': r.inspection, 'التاريخ': r.created_at,
    })));
    XLSX.utils.book_append_sheet(wb, ws2, 'المخالفات');

    const ws3 = XLSX.utils.json_to_sheet(r3.rows.map(r => ({
      'الإجراء': r.action, 'الموعد': r.due_date, 'الحالة': r.status, 'المسؤول': r.responsible, 'المخالفة': r.finding,
    })));
    XLSX.utils.book_append_sheet(wb, ws3, 'CAPA');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="inspection-hub-report.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في التصدير' }); }
});

// ══════════════════════════════════
//  API — USERS
// ══════════════════════════════════

// Lightweight list for dropdowns — accessible to all authenticated users
app.get('/api/users/dropdown', requireAuthAPI, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id,name,role FROM users ORDER BY name");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/users', requireAuthAPI, requireRole('superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id,name,username,role FROM users ORDER BY id");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/users', requireAuthAPI, requireRole('superadmin'), async (req, res) => {
  try {
    const { name, username, password, role } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const { rows: [u] } = await pool.query(
      "INSERT INTO users(name,username,password,role) VALUES($1,$2,$3,$4) RETURNING id,name,username,role",
      [name, username, hash, role]
    );
    await audit(req.session.userId, 'create_user', `مستخدم جديد: ${username}`);
    res.json(u);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'اسم المستخدم موجود مسبقاً' });
    res.status(500).json({ error: 'خطأ' });
  }
});

app.put('/api/users/:id', requireAuthAPI, requireRole('superadmin'), async (req, res) => {
  try {
    const { name, username, password, role } = req.body;
    let query, params;
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      query = "UPDATE users SET name=$1,username=$2,password=$3,role=$4 WHERE id=$5 RETURNING id,name,username,role";
      params = [name, username, hash, role, req.params.id];
    } else {
      query = "UPDATE users SET name=$1,username=$2,role=$3 WHERE id=$4 RETURNING id,name,username,role";
      params = [name, username, role, req.params.id];
    }
    const { rows: [u] } = await pool.query(query, params);
    res.json(u);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'اسم المستخدم موجود مسبقاً' });
    res.status(500).json({ error: 'خطأ' });
  }
});

app.delete('/api/users/:id', requireAuthAPI, requireRole('superadmin'), async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.userId) return res.status(400).json({ error: 'لا يمكن حذف حسابك الحالي' });
    await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

// ══════════════════════════════════
//  CAPA Scheduler — every 60 minutes
// ══════════════════════════════════
setInterval(async () => {
  try {
    await pool.query(`UPDATE capas SET status='overdue' WHERE status NOT IN ('closed','overdue') AND due_date < CURRENT_DATE`);
    await pool.query(`UPDATE capa_reminders SET sent=true WHERE remind_at<=NOW() AND sent=false`);
  } catch (e) { console.error('CAPA scheduler error:', e.message); }
}, 60 * 60 * 1000);

// ══════════════════════════════════
//  START
// ══════════════════════════════════
app.listen(PORT, async () => {
  try {
    await initDB();
    console.log(`✓ Inspection Hub running on port ${PORT}`);
  } catch (e) {
    console.error('DB init error:', e.message);
  }
});

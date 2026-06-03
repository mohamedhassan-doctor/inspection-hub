/**
 * seed-weekly.js
 * Idempotent seed: maps each department to its appropriate checklist types.
 * Called from initDB() in server.js on every startup (ON CONFLICT DO NOTHING).
 */
module.exports = async function seedWeekly(pool) {
  const mappings = [
    // أقسام سريرية — ICU، طوارئ، تنويم، جراحة، باطنة، تمريض
    {
      patterns: ['الطوارئ', 'الباطنة', 'الجراحة', 'العناية', 'التمريض', 'تنويم'],
      types: ['patient_safety', 'infection_control', 'fire_safety', 'medical_equipment'],
    },
    // العمليات
    {
      patterns: ['العمليات'],
      types: ['patient_safety', 'infection_control', 'fire_safety', 'medical_equipment', 'surgical_safety'],
    },
    // المختبر
    {
      patterns: ['المختبر'],
      types: ['lab_safety', 'infection_control'],
    },
    // الأشعة
    {
      patterns: ['الأشعة'],
      types: ['radiation_safety', 'medical_equipment'],
    },
    // الصيدلية
    {
      patterns: ['الصيدلية'],
      types: ['medication', 'environmental_safety'],
    },
    // المطبخ
    {
      patterns: ['المطبخ'],
      types: ['environmental_safety', 'fire_safety'],
    },
    // الغسيل المركزي
    {
      patterns: ['الغسيل'],
      types: ['infection_control', 'facilities_infrastructure'],
    },
  ];

  const { rows: depts } = await pool.query('SELECT id, name FROM departments');
  let inserted = 0;
  for (const dept of depts) {
    for (const mapping of mappings) {
      if (mapping.patterns.some(p => dept.name.includes(p))) {
        for (const type of mapping.types) {
          const r = await pool.query(
            'INSERT INTO department_checklist_types(department_id, checklist_type) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [dept.id, type]
          );
          inserted += r.rowCount;
        }
        break;
      }
    }
  }
  if (inserted > 0) console.log(`✓ Seeded ${inserted} department checklist type mappings`);
};

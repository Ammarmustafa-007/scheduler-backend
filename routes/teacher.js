import express from 'express';
import { checkRole } from '../middleware/checkRole.js';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

router.use(checkRole('teacher'));

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FALLBACK_TIME_SLOTS = [
  { slot_number: 1, start_time: '08:00:00', end_time: '09:15:00' },
  { slot_number: 2, start_time: '09:30:00', end_time: '10:45:00' },
  { slot_number: 3, start_time: '11:00:00', end_time: '12:15:00' },
  { slot_number: 4, start_time: '12:30:00', end_time: '13:45:00' },
  { slot_number: 5, start_time: '14:00:00', end_time: '15:15:00' },
  { slot_number: 6, start_time: '15:30:00', end_time: '16:45:00' }
];
const STATIC_DEV_TEACHER_NAME = 'Ms Nimra shafiq';

const romanMap = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8 };
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuid = (value) => typeof value === 'string' && uuidRegex.test(value);

const extractSemesterNumber = (section = '') => {
  const normalized = String(section || '').trim();
  const digits = normalized.match(/\d+/g);
  if (digits && digits.length > 0) {
    return parseInt(digits[digits.length - 1], 10);
  }

  const romanMatch = normalized.match(/(?:[- ])?(VIII|VII|VI|IV|V|III|II|I)[A-Z]?$/i);
  return romanMatch ? romanMap[romanMatch[1].toUpperCase()] || 99 : 99;
};

const normalizeName = (value = '') =>
  String(value)
    .toLowerCase()
    .replace(/\b(dr|prof|sir|mr|mrs|ms)\.?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const normalizeTime = (value) => {
  if (!value) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}:${match[3] || '00'}`;
};

const minutesFromTime = (value) => {
  const time = normalizeTime(value);
  if (!time) return null;
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

const rangesOverlap = (startA, endA, startB, endB) => {
  const aStart = minutesFromTime(startA);
  const aEnd = minutesFromTime(endA);
  const bStart = minutesFromTime(startB);
  const bEnd = minutesFromTime(endB);

  if ([aStart, aEnd, bStart, bEnd].some(value => value === null || Number.isNaN(value))) {
    return false;
  }

  return aStart < bEnd && aEnd > bStart;
};

const formatTime12Hour = (value) => {
  const minutes = minutesFromTime(value);
  if (minutes === null) return value || '';
  const hours24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const period = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${String(mins).padStart(2, '0')} ${period}`;
};

const formatTimeRange = (start, end) => `${formatTime12Hour(start)} - ${formatTime12Hour(end)}`;

const canonicalTimeSlots = () =>
  FALLBACK_TIME_SLOTS.map(slot => ({
    ...slot,
    value: `${slot.start_time}-${slot.end_time}`,
    label: `Slot ${slot.slot_number} · ${formatTimeRange(slot.start_time, slot.end_time)}`
  }));

const fetchPaged = async (createQuery, pageSize = 1000) => {
  let rows = [];
  let from = 0;

  while (true) {
    const { data, error } = await createQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows = rows.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return rows;
};

const getUserProfile = async (req) => {
  if (!isUuid(req.user?.id)) {
    const isDevTeacher = req.user?.id === 'dev-001';
    return {
      id: req.user?.id,
      email: isDevTeacher ? 'nimra.shafiq@teacher.uol.edu.pk' : req.user?.email,
      full_name: isDevTeacher ? STATIC_DEV_TEACHER_NAME : req.user?.full_name || req.user?.email || 'Teacher',
      university_id: isUuid(req.user?.university_id) ? req.user.university_id : null
    };
  }

  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name, university_id')
    .eq('id', req.user.id)
    .maybeSingle();

  if (error) throw error;

  return {
    ...req.user,
    ...(data || {}),
    full_name: data?.full_name || req.user?.full_name || req.user?.email || 'Teacher'
  };
};

const findTeacherRowsForUser = async (req, profile) => {
  const wantedName = normalizeName(profile?.full_name || profile?.email?.split('@')[0] || '');
  if (!wantedName) return [];

  let query = supabase
    .from('timetable_teachers')
    .select('id, name, university_id')
    .limit(5000);

  if (isUuid(profile?.university_id)) {
    query = query.eq('university_id', profile.university_id);
  } else if (isUuid(req.user?.university_id)) {
    query = query.eq('university_id', req.user.university_id);
  }

  const { data, error } = await query;
  if (error) throw error;

  const teachers = data || [];
  const directMatches = teachers.filter(teacher => {
    const teacherName = normalizeName(teacher.name);
    return teacherName.includes(wantedName) || wantedName.includes(teacherName);
  });

  if (directMatches.length > 0) return directMatches;

  const wantedTokens = wantedName.split(' ').filter(token => token.length > 2);
  const requiredOverlap = Math.min(2, wantedTokens.length);

  if (requiredOverlap === 0) return [];

  return teachers.filter(teacher => {
    const teacherTokens = new Set(normalizeName(teacher.name).split(' ').filter(token => token.length > 2));
    const overlap = wantedTokens.filter(token => teacherTokens.has(token)).length;
    return overlap >= requiredOverlap;
  });
};

const getTeacherSlotsForUser = async (req) => {
  const profile = await getUserProfile(req);
  const teacherRows = await findTeacherRowsForUser(req, profile);

  if (teacherRows.length === 0) {
    return { profile, teacherRows, slots: [], versionMap: new Map() };
  }

  const teacherIds = teacherRows.map(teacher => teacher.id);

  const slots = await fetchPaged(() =>
    supabase
      .from('timetable_slots')
      .select('id, version_id, subject, section, day, slot_number, start_time, end_time, teacher_id, room_id, slot_type, col_span, teacher:timetable_teachers(name), room:rooms(name)')
      .in('teacher_id', teacherIds)
      .order('day')
      .order('start_time')
  );

  const versionIds = [...new Set(slots.map(slot => slot.version_id).filter(Boolean))];
  const versionMap = new Map();

  if (versionIds.length > 0) {
    const { data: versions, error: versionError } = await supabase
      .from('timetable_versions')
      .select('id, semester_label, version_label, is_latest, uploaded_at, department_id')
      .in('id', versionIds);

    if (versionError) throw versionError;
    (versions || []).forEach(version => versionMap.set(version.id, version));
  }

  const latestVersionIds = new Set(
    [...versionMap.values()]
      .filter(version => version.is_latest)
      .map(version => version.id)
  );

  const scopedSlots = latestVersionIds.size > 0
    ? slots.filter(slot => latestVersionIds.has(slot.version_id))
    : slots;

  return { profile, teacherRows, slots: scopedSlots, versionMap };
};

const getPlannerCatalogForUser = async (req) => {
  const profile = await getUserProfile(req);
  // The planner browses the full latest timetable catalog, so matching the
  // current user against timetable_teachers is unnecessary here and can be slow
  // on large teacher tables.
  const teacherRows = [];

  const { data: latestVersions, error: latestVersionError } = await supabase
    .from('timetable_versions')
    .select('id, semester_label, version_label, is_latest, uploaded_at, department_id, department:departments(university_id)')
    .eq('is_latest', true)
    .order('uploaded_at', { ascending: false });

  if (latestVersionError) throw latestVersionError;

  const scopedVersions = (latestVersions || []).filter(version => {
    if (!isUuid(profile?.university_id)) return true;
    return version.department?.university_id === profile.university_id;
  });

  const versionMap = new Map();
  scopedVersions.forEach(version => versionMap.set(version.id, version));

  let slots = [];
  if (scopedVersions.length > 0) {
    slots = await fetchPaged(() =>
      supabase
        .from('timetable_slots')
        .select('id, version_id, subject, section, day, slot_number, start_time, end_time, room:rooms(name)')
        .in('version_id', scopedVersions.map(version => version.id))
        .order('day')
        .order('start_time')
    );
  } else {
    // Fallback for early/mock databases where versions may not be marked latest yet.
    slots = await fetchPaged(() =>
      supabase
        .from('timetable_slots')
        .select('id, version_id, subject, section, day, slot_number, start_time, end_time, room:rooms(name)')
        .order('day')
        .order('start_time')
    );

    const versionIds = [...new Set(slots.map(slot => slot.version_id).filter(Boolean))];
    if (versionIds.length > 0) {
      const { data: versions, error: versionError } = await supabase
        .from('timetable_versions')
        .select('id, semester_label, version_label, is_latest, uploaded_at, department_id')
        .in('id', versionIds);

      if (versionError) throw versionError;
      (versions || []).forEach(version => versionMap.set(version.id, version));
    }
  }

  return { profile, teacherRows, slots, versionMap };
};

const slotToConflict = (slot) => ({
  slot_id: slot.id,
  version_id: slot.version_id,
  subject: slot.subject,
  section: slot.section,
  semester_number: extractSemesterNumber(slot.section),
  day: slot.day,
  slot_number: slot.slot_number,
  start_time: normalizeTime(slot.start_time),
  end_time: normalizeTime(slot.end_time),
  time_label: formatTimeRange(slot.start_time, slot.end_time),
  teacher_name: slot.teacher?.name || slot.teacher_name || 'Staff',
  room_name: slot.room?.name || slot.room_name || 'TBA'
});

const emptyAvailability = (context = {}) => ({
  summary: {
    total_students: 0,
    free_count: 0,
    busy_count: 0,
    free_percentage: 0
  },
  context,
  free_students: [],
  busy_students: [],
  available_rooms: []
});

const getVersionUniversityId = async (versionId) => {
  if (!isUuid(versionId)) return null;

  const { data: version, error: versionError } = await supabase
    .from('timetable_versions')
    .select('department_id')
    .eq('id', versionId)
    .maybeSingle();

  if (versionError || !version?.department_id) return null;

  const { data: department, error: departmentError } = await supabase
    .from('departments')
    .select('university_id')
    .eq('id', version.department_id)
    .maybeSingle();

  if (departmentError) return null;
  return department?.university_id || null;
};

const getAvailableRooms = async ({ version_id, day, start_time, end_time }) => {
  if (!day || !start_time || !end_time) return [];

  const universityId = await getVersionUniversityId(version_id);
  let roomsQuery = supabase
    .from('rooms')
    .select('id, name, building, capacity, university_id')
    .order('name')
    .limit(80);

  if (isUuid(universityId)) {
    roomsQuery = roomsQuery.eq('university_id', universityId);
  }

  const { data: rooms, error: roomsError } = await roomsQuery;
  if (roomsError) return [];

  let bookedQuery = supabase
    .from('timetable_slots')
    .select('room_id, day, start_time, end_time')
    .eq('day', day);

  if (isUuid(version_id)) {
    bookedQuery = bookedQuery.eq('version_id', version_id);
  }

  const { data: bookedSlots, error: bookedError } = await bookedQuery;
  if (bookedError) return rooms || [];

  const bookedRoomIds = new Set(
    (bookedSlots || [])
      .filter(slot => slot.room_id && rangesOverlap(slot.start_time, slot.end_time, start_time, end_time))
      .map(slot => slot.room_id)
  );

  return (rooms || []).filter(room => !bookedRoomIds.has(room.id)).slice(0, 12);
};

// 1. GET /api/teacher/sections
router.get('/sections', async (req, res) => {
  try {
    const user_id = req.user.id;
    // Note: Assuming teacher_sections table exists as per spec
    const { data, error } = await supabase
      .from('teacher_sections')
      .select('*')
      .eq('teacher_id', user_id);
    
    // If table doesn't exist yet, just return empty array instead of failing
    if (error && error.code === '42P01') {
      return res.status(200).json([]);
    } else if (error) {
      throw error;
    }
    
    res.status(200).json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. POST /api/teacher/assign-section
router.post('/assign-section', async (req, res) => {
  try {
    const { section_id, section_name } = req.body;
    const user_id = req.user.id;

    if (!section_id || !section_name) return res.status(400).json({ error: 'Missing section_id or section_name' });

    const { error } = await supabase
      .from('teacher_sections')
      .upsert({ teacher_id: user_id, section_id, section_name });
      
    // Create table gracefully if missing
    if (error && error.code === '42P01') {
       console.log('teacher_sections table missing, requires DB migration');
       return res.status(400).json({ error: 'Database table teacher_sections is missing' });
    } else if (error) {
       throw error;
    }
    
    res.status(200).json({ status: 'assigned' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. GET /api/teacher/section/:sectionId/students
router.get('/section/:sectionId/students', async (req, res) => {
  try {
    const sectionName = req.params.sectionId;
    
    // Fetch slots for this section
    const { data: slots, error: slotsError } = await supabase
      .from('timetable_slots')
      .select('id')
      .eq('section', sectionName);
      
    if (slotsError) throw slotsError;
    if (!slots || slots.length === 0) return res.status(200).json([]);
    
    const slotIds = slots.map(s => s.id);
    
    // Fetch enrollments for these slots
    const { data: enrollments, error: enrollError } = await supabase
      .from('student_enrollments')
      .select('student_id, student:users(id, full_name, email)')
      .in('slot_id', slotIds);
      
    if (enrollError) throw enrollError;
    
    // Deduplicate students
    const studentMap = new Map();
    (enrollments || []).forEach(e => {
      if (e.student && !studentMap.has(e.student.id)) {
        studentMap.set(e.student.id, e.student);
      }
    });
    
    res.status(200).json(Array.from(studentMap.values()));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. GET /api/teacher/stats
router.get('/stats', async (req, res) => {
  try {
    const user_id = req.user.id;
    
    const { count: sectionsCount, error: secError } = await supabase
      .from('teacher_sections')
      .select('*', { count: 'exact', head: true })
      .eq('teacher_id', user_id);
      
    const { count: makeupCount, error: mkError } = await supabase
      .from('makeup_classes')
      .select('*', { count: 'exact', head: true })
      .eq('teacher_id', user_id);

    const { slots } = await getTeacherSlotsForUser(req);
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const todaySlots = slots.filter(slot => slot.day === today).length;

    let totalStudents = 0;
    const teacherSlotIds = slots.map(slot => slot.id).filter(Boolean);
    if (teacherSlotIds.length > 0) {
      const { data: enrollments } = await supabase
        .from('student_enrollments')
        .select('student_id')
        .in('slot_id', teacherSlotIds);

      totalStudents = new Set((enrollments || []).map(row => row.student_id).filter(Boolean)).size;
    }

    res.status(200).json({
      total_sections: secError ? 0 : sectionsCount || 0,
      total_students: totalStudents,
      makeup_classes: mkError ? 0 : makeupCount || 0,
      today_slots: todaySlots
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. GET /api/teacher/my-schedule
router.get('/my-schedule', async (req, res) => {
  try {
    const { slots: all_slots } = await getTeacherSlotsForUser(req);

    const schedule = all_slots.map(s => ({
      ...s,
      room_name: s.room?.name || 'TBA'
    }));
    
    res.status(200).json(schedule);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. GET /api/teacher/makeup/options
router.get('/makeup/options', async (req, res) => {
  try {
    const { profile, teacherRows, slots, versionMap } = await getPlannerCatalogForUser(req);

    const semesterMap = new Map();

    slots.forEach(slot => {
      if (!slot.subject || !slot.section) return;

      const semesterNumber = extractSemesterNumber(slot.section);
      if (!semesterMap.has(semesterNumber)) {
        semesterMap.set(semesterNumber, {
          semester_number: semesterNumber,
          label: semesterNumber === 99 ? 'Unmapped Semester' : `Semester ${semesterNumber}`,
          sections: new Set(),
          subjects: new Map()
        });
      }

      const semester = semesterMap.get(semesterNumber);
      semester.sections.add(slot.section);

      if (!semester.subjects.has(slot.subject)) {
        semester.subjects.set(slot.subject, {
          subject: slot.subject,
          sections: new Set(),
          version_ids: new Set(),
          section_version_ids: new Map(),
          meetings: [],
          meeting_count: 0
        });
      }

      const subject = semester.subjects.get(slot.subject);
      subject.sections.add(slot.section);
      if (slot.version_id) subject.version_ids.add(slot.version_id);
      if (!subject.section_version_ids.has(slot.section)) {
        subject.section_version_ids.set(slot.section, new Set());
      }
      if (slot.version_id) subject.section_version_ids.get(slot.section).add(slot.version_id);
      subject.meeting_count += 1;

      if (subject.meetings.length < 4) {
        subject.meetings.push({
          slot_id: slot.id,
          version_id: slot.version_id,
          version_label: versionMap.get(slot.version_id)?.version_label || null,
          section: slot.section,
          day: slot.day,
          slot_number: slot.slot_number,
          start_time: normalizeTime(slot.start_time),
          end_time: normalizeTime(slot.end_time),
          time_label: formatTimeRange(slot.start_time, slot.end_time),
          room_name: slot.room?.name || 'TBA'
        });
      }
    });

    const semesters = [...semesterMap.values()]
      .map(semester => ({
        semester_number: semester.semester_number,
        label: semester.label,
        section_count: semester.sections.size,
        subject_count: semester.subjects.size,
        sections: [...semester.sections].sort(),
        subjects: [...semester.subjects.values()]
          .map(subject => ({
            subject: subject.subject,
            sections: [...subject.sections].sort(),
            version_ids: [...subject.version_ids],
            section_version_ids: Object.fromEntries(
              [...subject.section_version_ids.entries()].map(([section, ids]) => [section, [...ids]])
            ),
            meeting_count: subject.meeting_count,
            meetings: subject.meetings.sort((a, b) => `${a.day}-${a.start_time}`.localeCompare(`${b.day}-${b.start_time}`))
          }))
          .sort((a, b) => a.subject.localeCompare(b.subject))
      }))
      .sort((a, b) => a.semester_number - b.semester_number);

    res.status(200).json({
      teacher: {
        full_name: profile.full_name,
        matched: teacherRows.length > 0,
        matched_names: teacherRows.map(teacher => teacher.name)
      },
      catalog_scope: 'all_latest_timetable',
      days: DAYS,
      semesters,
      time_slots: canonicalTimeSlots()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7. POST /api/teacher/makeup/check
router.post('/makeup/check', async (req, res) => {
  try {
    const {
      semester_number,
      subject,
      section,
      section_id,
      day,
      slot_number,
      start_time,
      end_time,
      version_id,
      version_ids
    } = req.body;

    const selectedDay = day;
    const selectedStart = normalizeTime(start_time);
    const selectedEnd = normalizeTime(end_time);
    const selectedSlotNumber = slot_number ? parseInt(slot_number, 10) : null;
    const sectionScope = section && section !== 'all' ? section : section_id;
    const scopedVersionIds = Array.isArray(version_ids)
      ? version_ids.filter(isUuid)
      : (isUuid(version_id) ? [version_id] : []);

    if (!selectedDay) {
       return res.status(400).json({ error: 'Please select a day for the makeup class.' });
    }

    if (!selectedStart || !selectedEnd) {
       return res.status(400).json({ error: 'Please select a valid makeup time slot.' });
    }

    if (!subject && !sectionScope) {
       return res.status(400).json({ error: 'Please select a subject or class section first.' });
    }

    let targetSlots = await fetchPaged(() => {
      let query = supabase
        .from('timetable_slots')
        .select('id, version_id, subject, section, day, slot_number, start_time, end_time, teacher_id, room_id, teacher:timetable_teachers(name), room:rooms(name)');

      if (scopedVersionIds.length > 0) query = query.in('version_id', scopedVersionIds);
      if (subject) query = query.eq('subject', subject);
      if (sectionScope) query = query.eq('section', sectionScope);

      return query;
    });

    const selectedSemester = semester_number !== undefined && semester_number !== null && semester_number !== ''
      ? parseInt(semester_number, 10)
      : null;

    if (selectedSemester && !Number.isNaN(selectedSemester)) {
      targetSlots = targetSlots.filter(slot => extractSemesterNumber(slot.section) === selectedSemester);
    }

    const context = {
      semester_number: selectedSemester,
      subject: subject || null,
      section: sectionScope || 'all',
      day: selectedDay,
      slot_number: selectedSlotNumber,
      start_time: selectedStart,
      end_time: selectedEnd,
      time_label: formatTimeRange(selectedStart, selectedEnd),
      version_id: scopedVersionIds[0] || null,
      version_ids: scopedVersionIds
    };

    if (!targetSlots || targetSlots.length === 0) {
       return res.status(200).json(emptyAvailability(context));
    }

    const targetSlotIds = targetSlots.map(slot => slot.id);
    const targetSlotMap = new Map(targetSlots.map(slot => [slot.id, slot]));

    const { data: enrollments, error: enrollmentError } = await supabase
      .from('student_enrollments')
      .select('student_id, slot_id, student:users(id, full_name, email)')
      .in('slot_id', targetSlotIds);

    if (enrollmentError) throw enrollmentError;

    const studentMap = new Map();

    (enrollments || []).forEach(e => {
      const id = e.student?.id || e.student_id;
      if (!id) return;

      if (!studentMap.has(id)) {
        studentMap.set(id, {
          id,
          full_name: e.student?.full_name || 'Unnamed student',
          email: e.student?.email || null,
          target_subject: subject || targetSlotMap.get(e.slot_id)?.subject || null,
          target_sections: new Set(),
          target_slots: []
        });
      }

      const student = studentMap.get(id);
      const targetSlot = targetSlotMap.get(e.slot_id);
      if (targetSlot?.section) student.target_sections.add(targetSlot.section);
      if (targetSlot) student.target_slots.push(slotToConflict(targetSlot));
    });

    const studentIds = [...studentMap.keys()];

    if (studentIds.length === 0) {
      return res.status(200).json(emptyAvailability(context));
    }

    const { data: studentSlots, error: studentSlotsError } = await supabase
      .from('student_enrollments')
      .select('student_id, slot:timetable_slots(id, version_id, subject, section, day, slot_number, start_time, end_time, teacher:timetable_teachers(name), room:rooms(name))')
      .in('student_id', studentIds);

    if (studentSlotsError) throw studentSlotsError;

    const conflictsByStudent = new Map();

    (studentSlots || []).forEach(enrollment => {
      const slot = enrollment.slot;
      if (!slot || slot.day !== selectedDay) return;

      const hasTimeOverlap = rangesOverlap(slot.start_time, slot.end_time, selectedStart, selectedEnd);
      const hasSlotNumberMatch = selectedSlotNumber && parseInt(slot.slot_number, 10) === selectedSlotNumber;

      if (!hasTimeOverlap && !hasSlotNumberMatch) return;

      if (!conflictsByStudent.has(enrollment.student_id)) {
        conflictsByStudent.set(enrollment.student_id, []);
      }

      conflictsByStudent.get(enrollment.student_id).push(slotToConflict(slot));
    });

    const free_students = [];
    const busy_students = [];

    studentMap.forEach(student => {
      const baseStudent = {
        ...student,
        target_sections: [...student.target_sections].sort()
      };
      delete baseStudent.target_slots;

      const conflicts = conflictsByStudent.get(student.id) || [];
      if (conflicts.length > 0) {
        busy_students.push({
          ...baseStudent,
          busy_with: conflicts
        });
      } else {
        free_students.push(baseStudent);
      }
    });

    const available_rooms = await getAvailableRooms({
      version_id: scopedVersionIds[0] || version_id,
      day: selectedDay,
      start_time: selectedStart,
      end_time: selectedEnd
    });

    const totalStudents = studentMap.size;

    res.status(200).json({
      summary: {
        total_students: totalStudents,
        free_count: free_students.length,
        busy_count: busy_students.length,
        free_percentage: totalStudents > 0 ? Math.round((free_students.length / totalStudents) * 100) : 0
      },
      context,
      free_students,
      busy_students,
      available_rooms
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 8. POST /api/teacher/makeup/save
router.post('/makeup/save', async (req, res) => {
  try {
    const { section_id, day, slot_number, room_id, version_id, free_count, busy_count } = req.body;
    const user_id = req.user.id;

    const { error } = await supabase
      .from('makeup_classes')
      .insert({
        teacher_id: user_id,
        section_id,
        day,
        slot_number,
        room_id,
        version_id,
        free_count,
        busy_count
      });
      
    if (error && error.code === '42P01') {
       return res.status(400).json({ error: 'Database table makeup_classes is missing' });
    } else if (error) {
       throw error;
    }
    
    res.status(200).json({ status: 'saved' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 8. GET /api/teacher/makeup/history
router.get('/makeup/history', async (req, res) => {
  try {
    const user_id = req.user.id;
    const { data, error } = await supabase
      .from('makeup_classes')
      .select('*, room:rooms(name)')
      .eq('teacher_id', user_id);
      
    if (error && error.code === '42P01') {
       return res.status(200).json([]);
    } else if (error) {
       throw error;
    }
    
    res.status(200).json(data || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

import express from 'express';
import { checkRole } from '../middleware/checkRole.js';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

router.use(checkRole('teacher'));

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
      
    // Fetch teacher's name to find schedule slots
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('full_name')
      .eq('id', user_id)
      .single();
      
    if (userError) throw userError;
    
    const { data: tTeacher } = await supabase
      .from('timetable_teachers')
      .select('id')
      .ilike('name', `%${userData.full_name}%`)
      .limit(1)
      .single();
      
    let todaySlots = 0;
    if (tTeacher) {
       const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
       const { count } = await supabase
         .from('timetable_slots')
         .select('*', { count: 'exact', head: true })
         .eq('teacher_id', tTeacher.id)
         .eq('day', today);
       todaySlots = count || 0;
    }

    res.status(200).json({
      total_sections: sectionsCount || 0,
      total_students: 0, // To be calculated properly later
      makeup_classes: makeupCount || 0,
      today_slots: todaySlots
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. GET /api/teacher/my-schedule
router.get('/my-schedule', async (req, res) => {
  try {
    const user_id = req.user.id;
    
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('full_name')
      .eq('id', user_id)
      .single();
      
    if (userError) throw userError;
    
    const { data: tTeacher } = await supabase
      .from('timetable_teachers')
      .select('id')
      .ilike('name', `%${userData.full_name}%`)
      .limit(1)
      .single();
      
    if (!tTeacher) return res.status(200).json([]);
    
    let all_slots = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('timetable_slots')
        .select('*, room:rooms(name)')
        .eq('teacher_id', tTeacher.id)
        .range(from, from + pageSize - 1);
        
      if (error) throw error;
      if (!data || data.length === 0) break;
      all_slots = all_slots.concat(data);
      if (data.length < pageSize) break;
      from += pageSize;
    }

    const schedule = all_slots.map(s => ({
      ...s,
      room_name: s.room?.name || 'TBA'
    }));
    
    res.status(200).json(schedule);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. POST /api/teacher/makeup/check
router.post('/makeup/check', async (req, res) => {
  try {
    const { section_id, day, slot_number, version_id } = req.body;
    
    if (!section_id || !day || !slot_number) {
       return res.status(400).json({ error: 'Missing section_id, day, or slot_number' });
    }

    // 1. Get all students in this section
    const { data: sectionSlots, error: sError } = await supabase
      .from('timetable_slots')
      .select('id')
      .eq('section', section_id);
    if (sError) throw sError;
    
    if (!sectionSlots || sectionSlots.length === 0) {
       return res.status(200).json({ free_students: [], busy_students: [], available_rooms: [] });
    }
    
    const slotIds = sectionSlots.map(s => s.id);
    const { data: enrollments, error: eError } = await supabase
      .from('student_enrollments')
      .select('student_id, student:users(id, full_name)')
      .in('slot_id', slotIds);
    if (eError) throw eError;
    
    const uniqueStudents = new Map();
    (enrollments || []).forEach(e => {
      if (e.student && !uniqueStudents.has(e.student_id)) {
        uniqueStudents.set(e.student_id, e.student);
      }
    });
    
    const studentIds = Array.from(uniqueStudents.keys());
    
    if (studentIds.length === 0) {
        return res.status(200).json({ free_students: [], busy_students: [], available_rooms: [] });
    }
    
    // 2. Fetch all enrollments for these students to check for clashes
    const { data: allStudentSlots, error: asError } = await supabase
      .from('student_enrollments')
      .select('student_id, slot:timetable_slots(day, slot_number)')
      .in('student_id', studentIds);
    if (asError) throw asError;
    
    const busyStudentIds = new Set();
    (allStudentSlots || []).forEach(enroll => {
       if (enroll.slot && enroll.slot.day === day && enroll.slot.slot_number === parseInt(slot_number)) {
          busyStudentIds.add(enroll.student_id);
       }
    });
    
    const free_students = [];
    const busy_students = [];
    uniqueStudents.forEach(student => {
       if (busyStudentIds.has(student.id)) {
          busy_students.push(student);
       } else {
          free_students.push(student);
       }
    });
    
    // 3. Find available rooms (Mocked for now since room schedules require checking all slots at this day/time)
    const { data: rooms } = await supabase.from('rooms').select('*').limit(5);

    res.status(200).json({
      free_students,
      busy_students,
      available_rooms: rooms || []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7. POST /api/teacher/makeup/save
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

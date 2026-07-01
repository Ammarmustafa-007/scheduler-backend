import express from 'express';
import { checkRole } from '../middleware/checkRole.js';
import { upload } from '../middleware/upload.js'; // Importing multer configured in upload.js
import { supabase } from '../lib/supabase.js';
import crypto from 'crypto';

const router = express.Router();

router.use(checkRole('admin'));

const VALID_SLOT_TYPES = new Set(['free', 'lecture', 'lab', 'extended']);
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const normalizeOptionalText = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
};

const normalizeDbTime = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const trimmed = String(value).trim();
  if (/^\d{2}:\d{2}$/.test(trimmed)) return `${trimmed}:00`;
  return trimmed;
};

const formatFlaggedSlot = (slot) => ({
  ...slot,
  teacher: slot.teacher?.name || null,
  room: slot.room?.name || null
});

const getFlaggedSlotsForVersion = async (versionId) => {
  const { data, error } = await supabase
    .from('timetable_slots')
    .select(`
      *,
      teacher:timetable_teachers(name),
      room:rooms(name)
    `)
    .eq('version_id', versionId)
    .eq('needs_review', true)
    .order('day')
    .order('start_time');

  if (error) throw error;
  return data.map(formatFlaggedSlot);
};

router.post('/upload', upload.single('file'), async (req, res) => {
  const uploadStartedAt = performance.now();
  const secondsSince = (start) => Number(((performance.now() - start) / 1000).toFixed(3));

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    const { university_id, department_id, semester_label, version_label, uploader_name } = req.body;

    if (!university_id || !department_id || !semester_label) {
      return res.status(400).json({ error: 'Missing required metadata fields (university_id, department_id, semester_label)' });
    }

    // 1. Calculate SHA-256 hash to prevent duplicate uploads
    const pdfHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

    // 2. Check if this exact PDF is already parsed for this department & semester
    const { data: existingVersion } = await supabase
      .from('timetable_versions')
      .select('id, version_label')
      .eq('department_id', department_id)
      .eq('semester_label', semester_label)
      .eq('pdf_hash', pdfHash)
      .single();

    if (existingVersion) {
      return res.status(409).json({ 
        status: 'already_parsed', 
        message: 'This exact PDF was already uploaded for this semester.',
        version_id: existingVersion.id
      });
    }

    // 3. Send to Python Parser
    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: 'application/pdf' });
    formData.append('pdf', blob, req.file.originalname || 'timetable.pdf');

    const parserStartedAt = performance.now();
    const parserResponse = await fetch(`${process.env.PYTHON_SERVICE_URL || 'http://localhost:5000'}/parse/pdfplumber`, {
      method: 'POST',
      body: formData
    });
    const parser_request_seconds = secondsSince(parserStartedAt);

    if (!parserResponse.ok) {
      const errorText = await parserResponse.text();
      throw new Error(`Parser service failed with status: ${parserResponse.status}. Details: ${errorText}`);
    }

    const parserJsonStartedAt = performance.now();
    const parsedData = await parserResponse.json();
    const parser_json_seconds = secondsSince(parserJsonStartedAt);
    
    // We expect the parser to return { pdfplumber: { summary: ... }, data: { semesters: ... } }
    // Or if hitting single engine directly it might return { engine: 'pdfplumber', summary: ..., data: ... }
    const summary = parsedData.summary || (parsedData.pdfplumber && parsedData.pdfplumber.summary);
    const hierarchy = parsedData.data;

    if (!hierarchy || !summary) {
      throw new Error("Invalid response format from parser");
    }

    // 4. Flatten JSON for RPC Payload
    const teachersSet = new Set();
    const roomsSet = new Set();
    const slots = [];

    // Helper to Convert "08:00 AM" to "08:00:00" for postgres time column
    const formatTime = (timeStr) => {
       if (!timeStr) return null;
       const parts = timeStr.split(' ');
       if (parts.length !== 2) return timeStr; // Already formatted or invalid
       const time = parts[0];
       const modifier = parts[1];
       let [hours, minutes] = time.split(':');
       if (hours === '12') hours = '00';
       if (modifier === 'PM') hours = (parseInt(hours, 10) + 12).toString();
       return `${hours.padStart(2, '0')}:${minutes}:00`;
    };

    const flattenStartedAt = performance.now();
    hierarchy.semesters.forEach(sem => {
      Object.entries(sem.timetable).forEach(([section, days]) => {
        Object.entries(days).forEach(([day, daySlots]) => {
          daySlots.forEach(slot => {
            if (slot.teacher) teachersSet.add(slot.teacher);
            if (slot.room) roomsSet.add(slot.room);

            slots.push({
              section: slot.section,
              day: slot.day,
              slot_number: slot.slot,
              start_time: formatTime(slot.start_time),
              end_time: formatTime(slot.end_time),
              subject: slot.subject,
              teacher: slot.teacher,
              room: slot.room,
              slot_type: slot.type,
              col_span: slot.col_span,
              needs_review: slot.needs_review,
              raw_cell_text: slot.cell_text
            });
          });
        });
      });
    });
    const flatten_seconds = secondsSince(flattenStartedAt);

    const teachers = Array.from(teachersSet).map(name => ({ name }));
    const rooms = Array.from(roomsSet).map(name => ({ name }));

    const rpcPayload = {
      metadata: {
        department_id,
        semester_label,
        version_label: version_label || 'v1',
        uploader_name: uploader_name || req.user?.full_name || 'Admin',
        admin_id: (req.user?.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.user.id)) ? req.user.id : null,
        pdf_hash: pdfHash,
        university_id,
        slots_count: summary.total_slots,
        needs_review_count: summary.needs_review_count
      },
      teachers,
      rooms,
      slots
    };

    // 5. Call Supabase RPC
    const rpcStartedAt = performance.now();
    const { data: newVersionId, error: rpcError } = await supabase.rpc('upload_parsed_timetable', {
      payload: rpcPayload
    });
    const rpc_seconds = secondsSince(rpcStartedAt);

    if (rpcError) {
      console.error("RPC Error details:", rpcError);
      return res.status(400).json({ 
        error: 'Database insertion failed', 
        details: rpcError.message || JSON.stringify(rpcError) 
      });
    }

    const needs_review_slots = summary.needs_review_count > 0
      ? await getFlaggedSlotsForVersion(newVersionId)
      : [];
    const timings = {
      parser_request_seconds,
      parser_json_seconds,
      parser_service: parsedData.timings || null,
      flatten_seconds,
      rpc_seconds,
      total_seconds: secondsSince(uploadStartedAt)
    };

    console.log('Upload timings:', timings);

    res.status(200).json({
      status: 'success',
      version_id: newVersionId,
      summary,
      needs_review_slots,
      timings
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to process and upload timetable', details: error.message });
  }
});

router.get('/versions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('timetable_versions')
      .select(`
        *,
        department:departments(name, code, university:universities(name))
      `)
      .order('uploaded_at', { ascending: false });
    if (error) throw error;

    const formattedData = data.map(item => ({
      ...item,
      university: { name: item.department?.university?.name || 'Unknown' },
      department: { name: item.department?.name || 'Unknown', code: item.department?.code || '' }
    }));

    res.status(200).json(formattedData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/versions/:id/sections', async (req, res) => {
  try {
    const { id } = req.params;
    let allSections = new Set();
    let from = 0;
    const limit = 1000;
    
    while (true) {
      const { data, error } = await supabase
        .from('timetable_slots')
        .select('section')
        .eq('version_id', id)
        .order('id')
        .range(from, from + limit - 1);
        
      if (error) throw error;
      if (!data || data.length === 0) break;
      
      data.forEach(d => { if (d.section) allSections.add(d.section); });
      if (data.length < limit) break;
      from += limit;
    }

    const sections = [...allSections].filter(Boolean).sort();
    res.status(200).json(sections);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    // Run all 6 queries in parallel to drastically improve API speed
    const [
      { count: total_users },
      { count: total_students },
      { count: total_teachers },
      { count: free_plan_students },
      { count: pro_plan_students },
      { count: total_versions }
    ] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }),
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'student'),
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'teacher'),
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'student').eq('plan', 'free'),
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'student').eq('plan', 'pro'),
      supabase.from('timetable_versions').select('*', { count: 'exact', head: true })
    ]);
    
    res.status(200).json({
      total_users: total_users || 0,
      total_students: total_students || 0,
      total_teachers: total_teachers || 0,
      free_plan_students: free_plan_students || 0,
      pro_plan_students: pro_plan_students || 0,
      total_versions: total_versions || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/universities', async (req, res) => {
  try {
    const { data, error } = await supabase.from('universities').select('*').order('name');
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/universities', async (req, res) => {
  try {
    const { name, city, country } = req.body;
    const { data, error } = await supabase.from('universities').insert([{ name, city, country }]).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/universities/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, city, country } = req.body;

    if (!uuidRegex.test(id)) {
      return res.status(400).json({ error: 'Invalid university ID' });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = normalizeOptionalText(name);
    if (city !== undefined) updateData.city = normalizeOptionalText(city);
    if (country !== undefined) updateData.country = normalizeOptionalText(country);

    if (!updateData.name && name !== undefined) {
      return res.status(400).json({ error: 'University name is required' });
    }

    const { data, error } = await supabase
      .from('universities')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/departments', async (req, res) => {
  try {
    const { university_id } = req.query;
    let query = supabase.from('departments').select('*').order('name');
    if (university_id) {
      if (!uuidRegex.test(university_id)) {
        return res.status(200).json([]); // Mock ID means it doesn't exist in Postgres
      }
      query = query.eq('university_id', university_id);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/departments', async (req, res) => {
  try {
    const { name, code, university_id } = req.body;
    
    if (!uuidRegex.test(university_id)) {
      return res.status(400).json({ error: "Invalid university ID. Please create a real university first." });
    }

    const { data, error } = await supabase.from('departments').insert([{ name, code, university_id }]).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/departments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, university_id } = req.body;

    if (!uuidRegex.test(id)) {
      return res.status(400).json({ error: 'Invalid department ID' });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = normalizeOptionalText(name);
    if (code !== undefined) updateData.code = normalizeOptionalText(code)?.toUpperCase() || null;
    if (university_id !== undefined) {
      if (!uuidRegex.test(university_id)) {
        return res.status(400).json({ error: 'Invalid university ID' });
      }
      updateData.university_id = university_id;
    }

    if (!updateData.name && name !== undefined) {
      return res.status(400).json({ error: 'Department name is required' });
    }

    if (!updateData.code && code !== undefined) {
      return res.status(400).json({ error: 'Department code is required' });
    }

    const { data, error } = await supabase
      .from('departments')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, role, plan, search } = req.query;
    let query = supabase.from('users').select('*', { count: 'exact' });
    
    if (role) query = query.eq('role', role);
    if (plan) query = query.eq('plan', plan);
    if (search) query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
    
    const start = (page - 1) * limit;
    const end = start + limit - 1;
    query = query.range(start, end).order('created_at', { ascending: false });
    
    const { data, error, count } = await query;
    if (error) throw error;
    
    res.status(200).json({ users: data, total: count, page: Number(page), limit: Number(limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { role, plan, pro_request_status } = req.body;
    const updateData = {};
    if (role !== undefined) updateData.role = role;
    if (plan !== undefined) updateData.plan = plan;
    if (pro_request_status !== undefined) updateData.pro_request_status = pro_request_status;
    
    const { data, error } = await supabase.from('users').update(updateData).eq('id', id).select().single();
    if (error) throw error;
    
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/users/:id/schedule', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('student_enrollments').select('timetable_slots(*)').eq('student_id', id);
    if (error) throw error;
    
    const slots = data.map(d => d.timetable_slots);
    res.status(200).json({ enrolled_slots: slots, total_slots: slots.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/users/:id/sections', async (req, res) => {
  try {
    res.status(200).json({ sections: [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/versions/:id/set-latest', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: version, error: fetchErr } = await supabase.from('timetable_versions').select('department_id').eq('id', id).single();
    if (fetchErr) throw fetchErr;
    
    const { error: updateAllErr } = await supabase.from('timetable_versions').update({ is_latest: false }).eq('department_id', version.department_id);
    if (updateAllErr) throw updateAllErr;
    
    const { data, error: updateErr } = await supabase.from('timetable_versions').update({ is_latest: true }).eq('id', id).select().single();
    if (updateErr) throw updateErr;
    
    res.status(200).json({ status: 'updated', version_id: data.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/versions/:id/flagged', async (req, res) => {
  try {
    const { id } = req.params;

    res.status(200).json(await getFlaggedSlotsForVersion(id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.patch('/slots/:id/review', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      subject,
      section,
      teacher,
      room,
      day,
      start_time,
      end_time,
      slot_type,
      col_span,
      mark_reviewed = true,
    } = req.body;

    const { data: existingSlot, error: slotError } = await supabase
      .from('timetable_slots')
      .select('id, version_id')
      .eq('id', id)
      .single();

    if (slotError) {
      if (slotError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Slot not found' });
      }
      throw slotError;
    }

    const { data: version, error: versionError } = await supabase
      .from('timetable_versions')
      .select('department_id')
      .eq('id', existingSlot.version_id)
      .single();

    if (versionError) throw versionError;

    const { data: department, error: departmentError } = await supabase
      .from('departments')
      .select('university_id')
      .eq('id', version.department_id)
      .single();

    if (departmentError) throw departmentError;

    const universityId = department.university_id;
    const updateData = {};

    if (subject !== undefined) updateData.subject = normalizeOptionalText(subject);
    if (section !== undefined) updateData.section = normalizeOptionalText(section);
    if (day !== undefined) updateData.day = normalizeOptionalText(day);
    if (start_time !== undefined) updateData.start_time = normalizeDbTime(start_time);
    if (end_time !== undefined) updateData.end_time = normalizeDbTime(end_time);

    if (slot_type !== undefined) {
      const normalizedSlotType = normalizeOptionalText(slot_type) || 'lecture';
      if (!VALID_SLOT_TYPES.has(normalizedSlotType)) {
        return res.status(400).json({ error: 'Invalid slot_type' });
      }
      updateData.slot_type = normalizedSlotType;
    }

    if (col_span !== undefined) {
      updateData.col_span = Math.max(1, Number(col_span) || 1);
    }

    if (teacher !== undefined) {
      const teacherName = normalizeOptionalText(teacher);
      if (teacherName) {
        const { data: teacherRow, error: teacherError } = await supabase
          .from('timetable_teachers')
          .upsert(
            { name: teacherName, university_id: universityId },
            { onConflict: 'university_id,name' }
          )
          .select('id')
          .single();

        if (teacherError) throw teacherError;
        updateData.teacher_id = teacherRow.id;
      } else {
        updateData.teacher_id = null;
      }
    }

    if (room !== undefined) {
      const roomName = normalizeOptionalText(room);
      if (roomName) {
        const { data: roomRow, error: roomError } = await supabase
          .from('rooms')
          .upsert(
            { name: roomName, university_id: universityId },
            { onConflict: 'university_id,name' }
          )
          .select('id')
          .single();

        if (roomError) throw roomError;
        updateData.room_id = roomRow.id;
      } else {
        updateData.room_id = null;
      }
    }

    if (mark_reviewed) updateData.needs_review = false;

    const { data: updatedSlot, error: updateError } = await supabase
      .from('timetable_slots')
      .update(updateData)
      .eq('id', id)
      .select(`
        *,
        teacher:timetable_teachers(name),
        room:rooms(name)
      `)
      .single();

    if (updateError) throw updateError;

    const { count, error: countError } = await supabase
      .from('timetable_slots')
      .select('*', { count: 'exact', head: true })
      .eq('version_id', existingSlot.version_id)
      .eq('needs_review', true);

    if (countError) throw countError;

    await supabase
      .from('timetable_versions')
      .update({ needs_review_count: count || 0 })
      .eq('id', existingSlot.version_id);

    res.status(200).json({
      ...formatFlaggedSlot(updatedSlot),
      remaining_needs_review_count: count || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/versions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // 1. Delete associated slots
    const { error: slotsError } = await supabase
      .from('timetable_slots')
      .delete()
      .eq('version_id', id);
    if (slotsError) throw slotsError;

    // 2. Delete the version itself
    const { error: versionError } = await supabase
      .from('timetable_versions')
      .delete()
      .eq('id', id);
    if (versionError) throw versionError;

    // 3. Clean up orphaned teachers
    // Get all teacher IDs currently in use
    const { data: usedTeachers, error: tError } = await supabase
      .from('timetable_slots')
      .select('teacher_id')
      .not('teacher_id', 'is', null);
      
    if (!tError && usedTeachers) {
      const activeTeacherIds = [...new Set(usedTeachers.map(s => s.teacher_id))];
      
      let teacherDeleteQuery = supabase.from('timetable_teachers').delete();
      if (activeTeacherIds.length > 0) {
        // Delete teachers whose ID is NOT IN the active list
        teacherDeleteQuery = teacherDeleteQuery.not('id', 'in', `(${activeTeacherIds.join(',')})`);
      } else {
        // If no active teachers, delete all teachers (filter by id is not null to affect all rows)
        teacherDeleteQuery = teacherDeleteQuery.not('id', 'is', null);
      }
      await teacherDeleteQuery;
    }

    // 4. Clean up orphaned rooms
    const { data: usedRooms, error: rError } = await supabase
      .from('timetable_slots')
      .select('room_id')
      .not('room_id', 'is', null);
      
    if (!rError && usedRooms) {
      const activeRoomIds = [...new Set(usedRooms.map(s => s.room_id))];
      
      let roomDeleteQuery = supabase.from('rooms').delete();
      if (activeRoomIds.length > 0) {
        roomDeleteQuery = roomDeleteQuery.not('id', 'in', `(${activeRoomIds.join(',')})`);
      } else {
        roomDeleteQuery = roomDeleteQuery.not('id', 'is', null);
      }
      await roomDeleteQuery;
    }

    res.status(200).json({ status: 'deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

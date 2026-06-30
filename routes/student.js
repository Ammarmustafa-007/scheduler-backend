import express from 'express';
import { checkRole } from '../middleware/checkRole.js';
import { supabase } from '../lib/supabase.js';
import { resolveSchedule } from '../lib/clashResolver.js';

import { upload } from '../middleware/upload.js';

const router = express.Router();

router.use(checkRole('student'));

router.post('/preferences/parse', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'POST /preferences/parse' });
});

router.post('/upgrade/request', async (req, res) => {
  try {
    const { pin } = req.body;
    if (pin !== '0000') {
      return res.status(400).json({ error: 'Invalid PIN. Please enter 0000 to simulate payment.' });
    }

    // Update user's pro_request_status in Supabase
    const { error } = await supabase
      .from('users')
      .update({ pro_request_status: 'pending' })
      .eq('id', req.user.id);

    if (error) throw error;

    res.status(200).json({ status: 'success', message: 'Payment processed. Request sent to admin for review.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/upgrade/acknowledge', async (req, res) => {
  try {
    const { error } = await supabase
      .from('users')
      .update({ pro_request_status: 'none' })
      .eq('id', req.user.id);

    if (error) throw error;

    res.status(200).json({ status: 'success' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/parse-personal', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: 'application/pdf' });
    formData.append('pdf', blob, req.file.originalname || 'timetable.pdf');

    const parserResponse = await fetch(`${process.env.PYTHON_SERVICE_URL || 'http://localhost:5000'}/parse/pdfplumber`, {
      method: 'POST',
      body: formData
    });

    if (!parserResponse.ok) {
      const errorText = await parserResponse.text();
      throw new Error(`Parser service failed with status: ${parserResponse.status}. Details: ${errorText}`);
    }

    const parsedData = await parserResponse.json();
    const summary = parsedData.summary || (parsedData.pdfplumber && parsedData.pdfplumber.summary);
    const hierarchy = parsedData.data;

    if (!hierarchy || !summary) {
      throw new Error("Invalid response format from parser");
    }

    const slots = [];

    const formatTime = (timeStr) => {
       if (!timeStr) return null;
       const parts = timeStr.split(' ');
       if (parts.length !== 2) return timeStr;
       const time = parts[0];
       const modifier = parts[1];
       let [hours, minutes] = time.split(':');
       if (hours === '12') hours = '00';
       if (modifier === 'PM') hours = (parseInt(hours, 10) + 12).toString();
       return `${hours.padStart(2, '0')}:${minutes}:00`;
    };

    hierarchy.semesters.forEach(sem => {
      Object.entries(sem.timetable).forEach(([section, days]) => {
        Object.entries(days).forEach(([day, daySlots]) => {
          daySlots.forEach(slot => {
            slots.push({
              section: slot.section,
              day: slot.day,
              slot_number: slot.slot,
              start_time: formatTime(slot.start_time),
              end_time: formatTime(slot.end_time),
              subject: slot.subject,
              teacher: { name: slot.teacher }, // DB equivalent format
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

    res.status(200).json({ slots, summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/schedules/generate', async (req, res) => {
  try {
    const { version_id, selected_subjects, soft_preferences, clash_priority, custom_slots } = req.body;
    
    if (!version_id && !custom_slots) {
      return res.status(400).json({ error: 'Missing version_id or custom_slots' });
    }

    if (!selected_subjects || !Array.isArray(selected_subjects)) {
      return res.status(400).json({ error: 'Missing selected_subjects' });
    }

    let all_slots = [];

    if (custom_slots) {
      all_slots = custom_slots;
    } else {
      // Fetch all slots for this version to run clash resolution
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data: pageData, error: slotsError } = await supabase
          .from('timetable_slots')
          .select('*, teacher:timetable_teachers(id, name)')
          .eq('version_id', version_id)
          .range(from, from + pageSize - 1);
          
        if (slotsError) throw slotsError;
        if (!pageData || pageData.length === 0) break;
        all_slots = all_slots.concat(pageData);
        if (pageData.length < pageSize) break;
        from += pageSize;
      }
    }

    // Run the resolver algorithm
    const result = resolveSchedule({
      selected_subjects,
      all_slots,
      soft_preferences,
      clash_priority
    });

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/enroll', async (req, res) => {
  try {
    const { slot_ids } = req.body;
    const user_id = req.user.id;

    if (!slot_ids || !Array.isArray(slot_ids)) {
      return res.status(400).json({ error: 'Missing slot_ids array' });
    }

    // Delete existing enrollments
    const { error: deleteError } = await supabase
      .from('student_enrollments')
      .delete()
      .eq('student_id', user_id);

    if (deleteError) throw deleteError;

    // Insert new enrollments
    if (slot_ids.length > 0) {
      const inserts = slot_ids.map(id => ({
        student_id: user_id,
        slot_id: id
      }));

      const { error: insertError } = await supabase
        .from('student_enrollments')
        .insert(inserts);

      if (insertError) throw insertError;
    }

    res.status(200).json({ status: 'locked', enrolled_count: slot_ids.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/schedule', async (req, res) => {
  try {
    const user_id = req.user.id;

    // Fetch enrolled slots
    const { data, error } = await supabase
      .from('student_enrollments')
      .select(`
        slot_id,
        timetable_slots (
          *,
          teacher:timetable_teachers(name)
        )
      `)
      .eq('student_id', user_id);

    if (error) throw error;

    const schedule = data.map(row => row.timetable_slots);
    
    res.status(200).json(schedule);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/export/ics', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /export/ics' });
});

export default router;

import express from 'express';
import { checkRole } from '../middleware/checkRole.js';
import { supabase } from '../lib/supabase.js';
import { resolveSchedule } from '../lib/clashResolver.js';

import { upload } from '../middleware/upload.js';

const router = express.Router();

router.use(checkRole('student'));

const GENERATION_TOKEN_COST = 100;

const isDevUser = (user) => user?.id === 'dev-001';

const getCalendarSemester = () => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const term = month <= 6 ? 'Spring' : 'Fall';

  return {
    semester_key: `calendar:${year}:${term.toLowerCase()}`,
    semester_label: `${term} ${year}`,
  };
};

const normalizeWalletRow = (row) => {
  const wallet = Array.isArray(row) ? row[0] : row;
  if (!wallet) return null;

  return {
    semester_key: wallet.semester_key,
    semester_label: wallet.semester_label,
    plan: wallet.plan,
    tokens_awarded: Number(wallet.tokens_awarded || 0),
    tokens_remaining: Number(wallet.tokens_remaining || 0),
    generation_cost: Number(wallet.generation_cost || GENERATION_TOKEN_COST),
    generation_count: Number(wallet.generation_count || 0),
    attempts_remaining: Math.floor(Number(wallet.tokens_remaining || 0) / Number(wallet.generation_cost || GENERATION_TOKEN_COST)),
  };
};

const isMissingRpcError = (error, functionName) => {
  const message = String(error?.message || '').toLowerCase();
  return (
    error?.code === 'PGRST202' ||
    error?.code === '42883' ||
    message.includes(functionName.toLowerCase())
  );
};

const resolveSemesterWallet = async ({ version_id, semester_key, semester_label }) => {
  if (semester_key) {
    return {
      semester_key,
      semester_label: semester_label || semester_key,
    };
  }

  if (version_id) {
    const { data, error } = await supabase
      .from('timetable_versions')
      .select('id, department_id, semester_label')
      .eq('id', version_id)
      .single();

    if (error) throw error;

    return {
      semester_key: `department:${data.department_id}:semester:${data.semester_label}`,
      semester_label: data.semester_label,
    };
  }

  return getCalendarSemester();
};

const getScheduleTokenStatus = async (user, walletIdentity) => {
  if (isDevUser(user)) {
    return {
      ...walletIdentity,
      plan: 'pro',
      tokens_awarded: 500,
      tokens_remaining: 500,
      generation_cost: GENERATION_TOKEN_COST,
      generation_count: 0,
      attempts_remaining: 5,
    };
  }

  const { data, error } = await supabase.rpc('get_semester_token_status', {
    p_user_id: user.id,
    p_semester_key: walletIdentity.semester_key,
    p_semester_label: walletIdentity.semester_label,
  });

  if (error) {
    if (isMissingRpcError(error, 'get_semester_token_status')) {
      const migrationError = new Error('Schedule token system is not installed yet. Run the new Supabase SQL migration first.');
      migrationError.status = 503;
      throw migrationError;
    }
    throw error;
  }

  return normalizeWalletRow(data);
};

const spendScheduleTokens = async (user, walletIdentity, metadata) => {
  if (isDevUser(user)) {
    return {
      ...walletIdentity,
      plan: 'pro',
      tokens_awarded: 500,
      tokens_remaining: 400,
      generation_cost: GENERATION_TOKEN_COST,
      generation_count: 1,
      attempts_remaining: 4,
    };
  }

  const { data, error } = await supabase.rpc('spend_schedule_generation_tokens', {
    p_user_id: user.id,
    p_semester_key: walletIdentity.semester_key,
    p_semester_label: walletIdentity.semester_label,
    p_cost: GENERATION_TOKEN_COST,
    p_metadata: metadata,
  });

  if (error) {
    if (isMissingRpcError(error, 'spend_schedule_generation_tokens')) {
      const migrationError = new Error('Schedule token system is not installed yet. Run the new Supabase SQL migration first.');
      migrationError.status = 503;
      throw migrationError;
    }
    throw error;
  }

  return normalizeWalletRow(data);
};

router.post('/preferences/parse', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'POST /preferences/parse' });
});

router.get('/tokens/status', async (req, res) => {
  try {
    const { version_id, semester_key, semester_label } = req.query;
    const walletIdentity = await resolveSemesterWallet({ version_id, semester_key, semester_label });
    const tokenStatus = await getScheduleTokenStatus(req.user, walletIdentity);

    res.status(200).json(tokenStatus);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
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
    const { version_id, selected_subjects, soft_preferences, clash_priority, custom_slots, semester_key, semester_label } = req.body;
    
    if (!version_id && !custom_slots) {
      return res.status(400).json({ error: 'Missing version_id or custom_slots' });
    }

    if (!selected_subjects || !Array.isArray(selected_subjects)) {
      return res.status(400).json({ error: 'Missing selected_subjects' });
    }

    const walletIdentity = await resolveSemesterWallet({ version_id, semester_key, semester_label });
    const tokenStatus = await getScheduleTokenStatus(req.user, walletIdentity);

    if (tokenStatus.tokens_remaining < GENERATION_TOKEN_COST) {
      return res.status(402).json({
        error: 'No schedule tokens remaining for this semester.',
        token_status: tokenStatus,
      });
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
          .select('*, teacher:timetable_teachers(id, name), room:rooms(id, name)')
          .eq('version_id', version_id)
          .range(from, from + pageSize - 1);
          
        if (slotsError) throw slotsError;
        if (!pageData || pageData.length === 0) break;
        all_slots = all_slots.concat(pageData.map(slot => ({
          ...slot,
          room: slot.room?.name || null
        })));
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

    const updatedTokenStatus = await spendScheduleTokens(req.user, walletIdentity, {
      source: custom_slots ? 'personal_pdf' : 'university_database',
      version_id: version_id || null,
      selected_subjects_count: selected_subjects.length,
    });

    res.status(200).json({ ...result, token_status: updatedTokenStatus });
  } catch (error) {
    const isTokenLimit = String(error.message || '').toLowerCase().includes('not enough schedule tokens');
    res.status(error.status || (isTokenLimit ? 402 : 500)).json({ error: error.message });
  }
});

router.post('/enroll', async (req, res) => {
  try {
    const { slot_ids } = req.body;
    const user_id = req.user.id;

    if (!slot_ids || !Array.isArray(slot_ids)) {
      return res.status(400).json({ error: 'Missing slot_ids array' });
    }

    const uniqueSlotIds = [...new Set(slot_ids)].filter(Boolean);

    // Prefer the Supabase RPC so delete + insert happen in one DB transaction.
    const { data: rpcCount, error: rpcError } = await supabase.rpc('save_student_schedule', {
      p_student_id: user_id,
      p_slot_ids: uniqueSlotIds
    });

    if (rpcError) {
      const missingRpc =
        rpcError.code === 'PGRST202' ||
        rpcError.code === '42883' ||
        String(rpcError.message || '').toLowerCase().includes('save_student_schedule');

      if (!missingRpc) throw rpcError;

      console.warn('save_student_schedule RPC missing; falling back to legacy enrollment save.');

      // Legacy fallback for local/dev databases that have not run the RPC migration yet.
      const { error: deleteError } = await supabase
        .from('student_enrollments')
        .delete()
        .eq('student_id', user_id);

      if (deleteError) throw deleteError;

      if (uniqueSlotIds.length > 0) {
        const inserts = uniqueSlotIds.map(id => ({
          student_id: user_id,
          slot_id: id
        }));

        const { error: insertError } = await supabase
          .from('student_enrollments')
          .insert(inserts);

        if (insertError) throw insertError;
      }

      return res.status(200).json({ status: 'locked', enrolled_count: uniqueSlotIds.length });
    }

    res.status(200).json({ status: 'locked', enrolled_count: rpcCount ?? uniqueSlotIds.length });
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
          teacher:timetable_teachers(name),
          room:rooms(id, name)
        )
      `)
      .eq('student_id', user_id);

    if (error) throw error;

    const schedule = data.map(row => ({
      ...row.timetable_slots,
      room: row.timetable_slots?.room?.name || null
    }));
    
    res.status(200).json(schedule);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/export/ics', (req, res) => {
  res.status(200).json({ status: 'ok', route: 'GET /export/ics' });
});

export default router;

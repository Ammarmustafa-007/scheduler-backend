import express from 'express';
import { checkRole } from '../middleware/checkRole.js';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

router.use(checkRole(['admin', 'student', 'teacher']));

router.get('/universities', async (req, res) => {
  try {
    const { data, error } = await supabase.from('universities').select('*').order('name');
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
      query = query.eq('university_id', university_id);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/latest', async (req, res) => {
  try {
    const { department_id, semester_label } = req.query;
    if (!department_id || !semester_label) {
       return res.status(400).json({ error: 'Missing department_id or semester_label' });
    }

    const { data, error } = await supabase
      .from('timetable_versions')
      .select('id, version_label, uploaded_at, is_latest, slots_count, needs_review_count')
      .eq('department_id', department_id)
      .eq('semester_label', semester_label)
      .eq('is_latest', true)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
         // No rows found
         return res.status(404).json({ error: 'No timetable found for this department and semester' });
      }
      throw error;
    }

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/slots', async (req, res) => {
  try {
    const { version_id, section } = req.query;
    if (!version_id) {
       return res.status(400).json({ error: 'Missing version_id' });
    }

    let query = supabase
       .from('timetable_slots')
       .select('*')
       .eq('version_id', version_id)
       .order('day')
       .order('start_time');

    if (section) {
       query = query.ilike('section', section);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/versions', async (req, res) => {
  try {
    const { department_id } = req.query;
    if (!department_id) {
       return res.status(400).json({ error: 'Missing department_id' });
    }

    const { data, error } = await supabase
      .from('timetable_versions')
      .select('id, semester_label, version_label, uploaded_at, is_latest, slots_count, needs_review_count')
      .eq('department_id', department_id)
      .order('uploaded_at', { ascending: false });

    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/semesters', async (req, res) => {
  try {
    const { version_id } = req.query;
    if (!version_id) return res.status(400).json({ error: 'Missing version_id' });

    let data = [];
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data: pageData, error } = await supabase
        .from('timetable_slots')
        .select('section, subject')
        .eq('version_id', version_id)
        .range(from, from + pageSize - 1);
      
      if (error) throw error;
      if (!pageData || pageData.length === 0) break;
      data = data.concat(pageData);
      if (pageData.length < pageSize) break;
      from += pageSize;
    }

    const romanMap = { 'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8 };

    const semesterMap = {};
    data.forEach(slot => {
      if (!slot.section) return;
      
      let semNum = 0;
      const digits = slot.section.match(/\d+/g);
      if (digits && digits.length > 0) {
        semNum = parseInt(digits[digits.length - 1], 10);
      } else {
        // Check for roman numerals like BSCS-IV
        const romanMatch = slot.section.match(/(?:[- ])?(VIII|VII|VI|IV|V|III|II|I)[A-Z]?$/i);
        if (romanMatch && romanMap[romanMatch[1].toUpperCase()]) {
          semNum = romanMap[romanMatch[1].toUpperCase()];
        } else {
          // If totally unrecognized, group them into Semester 99
          semNum = 99;
        }
      }
      if (!semesterMap[semNum]) {
        semesterMap[semNum] = { semester_number: semNum, sections: new Set(), subjects: new Set() };
      }
      semesterMap[semNum].sections.add(slot.section);
      semesterMap[semNum].subjects.add(slot.subject);
    });

    const result = Object.values(semesterMap).map(sem => ({
      semester_number: sem.semester_number,
      section_count: sem.sections.size,
      subject_count: Array.from(sem.subjects).filter(s => !String(s).toLowerCase().includes('lab')).length,
      sections: Array.from(sem.sections).sort()
    })).sort((a,b) => a.semester_number - b.semester_number);

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/subjects', async (req, res) => {
  try {
    const { version_id, semesters } = req.query;
    if (!version_id || !semesters) return res.status(400).json({ error: 'Missing version_id or semesters' });
    
    const semArray = semesters.split(',').map(s => parseInt(s.trim(), 10));

    let slots = [];
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
      slots = slots.concat(pageData);
      if (pageData.length < pageSize) break;
      from += pageSize;
    }

    const filteredSlots = slots.filter(slot => {
      if (!slot.section) return false;
      
      let semNum = 0;
      const digits = slot.section.match(/\d+/g);
      if (digits && digits.length > 0) {
        semNum = parseInt(digits[digits.length - 1], 10);
      } else {
        const romanMatch = slot.section.match(/(?:[- ])?(VIII|VII|VI|IV|V|III|II|I)[A-Z]?$/i);
        if (romanMatch) {
          const romanMap = { 'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8 };
          semNum = romanMap[romanMatch[1].toUpperCase()] || 99;
        } else {
          semNum = 99;
        }
      }
      return semArray.includes(semNum);
    });

    const subjectMap = {};

    filteredSlots.forEach(slot => {
      if (!slot.section || !slot.subject) return;

      let semNum = 0;
      const digits = slot.section.match(/\d+/g);
      if (digits && digits.length > 0) {
        semNum = parseInt(digits[digits.length - 1], 10);
      } else {
        const romanMatch = slot.section.match(/(?:[- ])?(VIII|VII|VI|IV|V|III|II|I)[A-Z]?$/i);
        if (romanMatch) {
          const romanMap = { 'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8 };
          semNum = romanMap[romanMatch[1].toUpperCase()] || 99;
        } else {
          semNum = 99;
        }
      }
      
      const isLab = String(slot.subject).toLowerCase().includes('lab');
      
      if (!subjectMap[slot.subject]) {
        subjectMap[slot.subject] = {
          subject: slot.subject,
          display_name: slot.subject,
          is_lab: isLab,
          paired_lab: null,
          semester_number: semNum,
          available_sections: []
        };
      }
      
      const existingSec = subjectMap[slot.subject].available_sections.find(s => s.section === slot.section);
      if (existingSec) {
        existingSec.slots.push({
          id: slot.id,
          day: slot.day,
          start_time: slot.start_time,
          end_time: slot.end_time,
          slot_number: slot.slot_number,
          room: slot.room?.name || null
        });
      } else {
        subjectMap[slot.subject].available_sections.push({
          section: slot.section,
          teacher: slot.teacher?.name || 'Staff',
          teacher_id: slot.teacher_id,
          slots: [{
             id: slot.id,
             day: slot.day,
             start_time: slot.start_time,
             end_time: slot.end_time,
             slot_number: slot.slot_number,
             room: slot.room?.name || null
          }]
        });
      }
    });

    const finalSubjects = Object.values(subjectMap);
    finalSubjects.forEach(subj => {
      if (!subj.is_lab) {
        const labSubj = finalSubjects.find(s => s.is_lab && s.subject.startsWith(subj.subject));
        if (labSubj) {
          subj.paired_lab = labSubj.subject;
        }
      }
    });

    res.status(200).json(finalSubjects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

export const resolveSchedule = ({ selected_subjects, all_slots, soft_preferences, clash_priority = 'teacher' }) => {
  let score = 0;
  let maxPossibleScore = selected_subjects.length * 100; // soft preferences add bonus
  const schedule = [];
  const match_summary = [];
  const unresolvable = [];
  
  // Track occupied time slots for the student to prevent clashes
  // Format: "Day-SlotNumber" -> true
  const occupiedTimes = new Set();
  
  // Group slots by subject for easier lookup
  const slotsBySubject = {};
  all_slots.forEach(slot => {
    if (!slotsBySubject[slot.subject]) {
      slotsBySubject[slot.subject] = [];
    }
    slotsBySubject[slot.subject].push(slot);
  });

  // Calculate constraint level for each subject (fewer sections = more constrained)
  const subjectConstraints = selected_subjects.map(subj => {
    const subjSlots = slotsBySubject[subj.subject] || [];
    // Count unique sections for this subject
    const uniqueSections = new Set(subjSlots.map(s => s.section)).size;
    return { ...subj, optionsCount: uniqueSections };
  });

  // Sort subjects: Most constrained first (fewest sections). 
  // BUT ensure theory subjects are processed before their labs!
  subjectConstraints.sort((a, b) => {
    if (b.subject.startsWith(a.subject) && b.subject !== a.subject) return -1;
    if (a.subject.startsWith(b.subject) && a.subject !== b.subject) return 1;
    return a.optionsCount - b.optionsCount;
  });

  // Helper to check if a specific section's slots conflict with occupied times
  const checkClash = (sectionSlots) => {
    return sectionSlots.some(slot => occupiedTimes.has(`${slot.day}-${slot.slot_number}`));
  };

  const assignSection = (sectionSlots, subjectName, matchType, note, points) => {
    sectionSlots.forEach(slot => {
      schedule.push({
        ...slot,
        match_type: matchType,
        preference_note: note
      });
      occupiedTimes.add(`${slot.day}-${slot.slot_number}`);
    });
    score += points;
    match_summary.push({ subject: subjectName, match_type: matchType, note });
    return sectionSlots[0].section;
  };

  // Extract soft bonus calculation
  const calculateSoftBonus = (simulatedSchedule) => {
    let bonus = 0;
    if (soft_preferences?.free_day_preference) {
      const hasClassOnFreeDay = simulatedSchedule.some(s => s.day === soft_preferences.free_day_preference);
      if (!hasClassOnFreeDay) bonus += 10;
    }
    if (soft_preferences?.avoid_first_slot) {
      const hasEarlyClass = simulatedSchedule.some(s => s.slot_number === 1);
      if (!hasEarlyClass) bonus += 5;
    }
    if (soft_preferences?.avoid_last_slot) {
      // Assuming 5 or 6 is the last slot depending on the timetable. Let's assume >= 5.
      const hasLateClass = simulatedSchedule.some(s => s.slot_number >= 5);
      if (!hasLateClass) bonus += 5;
    }
    if (soft_preferences?.minimize_gaps) {
      const byDay = {};
      simulatedSchedule.forEach(s => {
        if (!byDay[s.day]) byDay[s.day] = [];
        byDay[s.day].push(s.slot_number);
      });
      let totalGaps = 0;
      for (const day in byDay) {
        const slots = byDay[day].sort((a,b) => a - b);
        for (let i = 0; i < slots.length - 1; i++) {
          const gap = slots[i+1] - slots[i] - 1;
          if (gap > 0) totalGaps += gap;
        }
      }
      bonus -= (totalGaps * 5);
    }
    return bonus;
  };

  // Deep Scan Helper
  // Evaluates a list of valid (non-clashing) sections and returns the one that yields the best soft score
  const getBestSectionByTime = (validSections) => {
    let bestSection = null;
    let bestScore = -Infinity;

    for (const sec of validSections) {
      // Simulate adding this section to the current schedule
      const simulatedSchedule = [...schedule, ...sec];
      const simScore = calculateSoftBonus(simulatedSchedule);
      
      if (simScore > bestScore) {
        bestScore = simScore;
        bestSection = sec;
      }
    }
    return bestSection;
  };

  const assignedSectionsBySubject = {};

  // Resolve subjects
  for (const subj of subjectConstraints) {
    const subjSlots = slotsBySubject[subj.subject] || [];
    
    const sectionsObj = {};
    subjSlots.forEach(s => {
      if (!sectionsObj[s.section]) sectionsObj[s.section] = [];
      sectionsObj[s.section].push(s);
    });
    let sections = Object.values(sectionsObj);

    // Enforce Lab and Theory in the same section
    const parentTheory = subjectConstraints.find(s => s.subject !== subj.subject && subj.subject.startsWith(s.subject));
    if (parentTheory && assignedSectionsBySubject[parentTheory.subject]) {
      const requiredSection = assignedSectionsBySubject[parentTheory.subject];
      sections = sections.filter(sec => sec[0].section === requiredSection);
    }

    if (sections.length === 0) {
      unresolvable.push(subj.subject);
      match_summary.push({ subject: subj.subject, match_type: 'unresolvable', note: 'No sections available for this subject' });
      continue;
    }

    let assigned = false;
    let prefSlot = null;
    if (subj.preferred_slot_id) {
       prefSlot = all_slots.find(s => s.id === subj.preferred_slot_id);
    }
    
    // Attempt 1: Perfect match (user selected a preference, and that section has no clash)
    if (prefSlot) {
      const targetSectionSlots = sections.find(sec => sec[0].section === prefSlot.section);
      if (targetSectionSlots && !checkClash(targetSectionSlots)) {
        assignedSectionsBySubject[subj.subject] = assignSection(targetSectionSlots, subj.subject, 'perfect', `${prefSlot.teacher?.name || 'Preferred teacher'} (preferred)`, 100);
        assigned = true;
        continue;
      }
    }

    // Get all valid non-clashing sections
    const validSections = sections.filter(sec => !checkClash(sec));

    if (!assigned && validSections.length > 0) {
      // Attempt 2: Teacher Priority -> Try to keep the same teacher
      if (clash_priority === 'teacher' && prefSlot && prefSlot.teacher_id) {
        const sameTeacherSections = validSections.filter(sec => sec[0].teacher_id === prefSlot.teacher_id && sec[0].section !== prefSlot.section);
        
        if (sameTeacherSections.length > 0) {
          // If multiple options with the same teacher exist, do a deep scan to pick the best fit among them
          const bestSameTeacherSec = getBestSectionByTime(sameTeacherSections);
          assignedSectionsBySubject[subj.subject] = assignSection(bestSameTeacherSec, subj.subject, 'teacher_kept', `Different section, but kept preferred teacher ${prefSlot.teacher?.name || ''}`, 80);
          assigned = true;
        }
      }

      // Attempt 3: Time Priority, or Teacher fallback failed, or No Preference provided
      if (!assigned) {
        const bestSection = getBestSectionByTime(validSections);
        
        if (bestSection) {
          if (prefSlot) {
            const priorityNote = clash_priority === 'time' 
              ? `Prioritized schedule fit over teacher — assigned to ${bestSection[0].teacher?.name || 'available slot'}`
              : `Clashed with preferred option — assigned to ${bestSection[0].teacher?.name || 'available slot'}`;
            assignedSectionsBySubject[subj.subject] = assignSection(bestSection, subj.subject, 'compromised', priorityNote, 60);
          } else {
            assignedSectionsBySubject[subj.subject] = assignSection(bestSection, subj.subject, 'perfect', `Assigned optimal slot based on preferences`, 100);
          }
          assigned = true;
        }
      }
    }

    // Attempt 4: Hard clash
    if (!assigned) {
      unresolvable.push(subj.subject);
      match_summary.push({ subject: subj.subject, match_type: 'unresolvable', note: 'All available sections conflict with your current schedule' });
    }
  }

  // Calculate Final Soft Preferences Bonus
  let softBonus = calculateSoftBonus(schedule);
  
  if (soft_preferences?.free_day_preference) {
    const hasClassOnFreeDay = schedule.some(s => s.day === soft_preferences.free_day_preference);
    if (!hasClassOnFreeDay) {
      match_summary.push({ subject: soft_preferences.free_day_preference, match_type: 'perfect', note: 'No classes — free day achieved' });
    }
  }

  // Calculate final score
  let finalScore = ((score + softBonus) / maxPossibleScore) * 100;
  if (finalScore > 100) finalScore = 100;
  if (finalScore < 0) finalScore = 0;

  return {
    schedule,
    score: Math.round(finalScore),
    match_summary,
    unresolvable
  };
};

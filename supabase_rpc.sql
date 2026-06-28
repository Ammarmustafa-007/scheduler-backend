-- 1. FIX SCHEMA: Drop the old pdf_hash constraint and create the safer composite constraint
ALTER TABLE timetable_versions DROP CONSTRAINT IF EXISTS timetable_versions_pdf_hash_key;
ALTER TABLE timetable_versions ADD CONSTRAINT timetable_versions_unique_upload UNIQUE (department_id, semester_label, pdf_hash);

-- 2. FIX SCHEMA: Add missing columns to timetable_slots so frontend can render properly
ALTER TABLE timetable_slots ADD COLUMN IF NOT EXISTS slot_type text DEFAULT 'free' CHECK (slot_type IN ('free', 'lecture', 'lab', 'extended'));
ALTER TABLE timetable_slots ADD COLUMN IF NOT EXISTS col_span int DEFAULT 1;
ALTER TABLE timetable_slots ADD COLUMN IF NOT EXISTS raw_cell_text text;

-- 3. CREATE RPC: The transactional upload function
CREATE OR REPLACE FUNCTION public.upload_parsed_timetable(payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_department_id uuid;
  v_semester_label text;
  v_version_label text;
  v_uploader_name text;
  v_admin_id uuid;
  v_pdf_hash text;
  v_university_id uuid;
  
  v_slots_count int;
  v_needs_review_count int;
  
  v_new_version_id uuid;
  
  teacher_rec jsonb;
  room_rec jsonb;
  slot_rec jsonb;
  
  v_teacher_id uuid;
  v_room_id uuid;
BEGIN
  -- 1. Extract Metadata
  v_department_id := (payload->'metadata'->>'department_id')::uuid;
  v_semester_label := payload->'metadata'->>'semester_label';
  v_version_label := payload->'metadata'->>'version_label';
  v_uploader_name := payload->'metadata'->>'uploader_name';
  v_admin_id := (payload->'metadata'->>'admin_id')::uuid;
  v_pdf_hash := payload->'metadata'->>'pdf_hash';
  v_university_id := (payload->'metadata'->>'university_id')::uuid;
  v_slots_count := (payload->'metadata'->>'slots_count')::int;
  v_needs_review_count := (payload->'metadata'->>'needs_review_count')::int;

  -- 2. Set existing versions to false
  UPDATE public.timetable_versions
  SET is_latest = false
  WHERE department_id = v_department_id;

  -- 3. Insert new version (will fail if pdf_hash + semester + dept already exists)
  INSERT INTO public.timetable_versions (
    department_id, pdf_hash, semester_label, version_label, 
    uploader_name, admin_id, is_latest, slots_count, needs_review_count
  ) VALUES (
    v_department_id, v_pdf_hash, v_semester_label, v_version_label, 
    v_uploader_name, v_admin_id, true, v_slots_count, v_needs_review_count
  ) RETURNING id INTO v_new_version_id;

  -- 4. Upsert Teachers
  FOR teacher_rec IN SELECT * FROM jsonb_array_elements(payload->'teachers')
  LOOP
    INSERT INTO public.timetable_teachers (name, university_id)
    VALUES (teacher_rec->>'name', v_university_id)
    ON CONFLICT (university_id, name) DO NOTHING;
  END LOOP;

  -- 5. Upsert Rooms
  FOR room_rec IN SELECT * FROM jsonb_array_elements(payload->'rooms')
  LOOP
    INSERT INTO public.rooms (name, university_id)
    VALUES (room_rec->>'name', v_university_id)
    ON CONFLICT (university_id, name) DO NOTHING;
  END LOOP;

  -- 6. Insert Slots
  FOR slot_rec IN SELECT * FROM jsonb_array_elements(payload->'slots')
  LOOP
    -- Resolve Teacher ID
    v_teacher_id := NULL;
    IF slot_rec->>'teacher' IS NOT NULL THEN
      SELECT id INTO v_teacher_id FROM public.timetable_teachers 
      WHERE name = slot_rec->>'teacher' AND university_id = v_university_id;
    END IF;

    -- Resolve Room ID
    v_room_id := NULL;
    IF slot_rec->>'room' IS NOT NULL THEN
      SELECT id INTO v_room_id FROM public.rooms 
      WHERE name = slot_rec->>'room' AND university_id = v_university_id;
    END IF;

    -- Insert Slot
    INSERT INTO public.timetable_slots (
      version_id, section, day, slot_number, 
      start_time, end_time, subject, 
      teacher_id, room_id, slot_type, 
      col_span, needs_review, raw_cell_text
    ) VALUES (
      v_new_version_id,
      slot_rec->>'section',
      slot_rec->>'day',
      (slot_rec->>'slot_number')::int,
      (slot_rec->>'start_time')::time,
      (slot_rec->>'end_time')::time,
      slot_rec->>'subject',
      v_teacher_id,
      v_room_id,
      COALESCE(slot_rec->>'slot_type', 'free'),
      COALESCE((slot_rec->>'col_span')::int, 1),
      COALESCE((slot_rec->>'needs_review')::boolean, false),
      slot_rec->>'raw_cell_text'
    );
  END LOOP;

  -- Return the successfully created version ID
  RETURN v_new_version_id;
END;
$$;

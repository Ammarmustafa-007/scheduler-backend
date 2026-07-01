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

-- 4. ENROLLMENT HELPERS: support student saved schedules and teacher makeup planning
CREATE INDEX IF NOT EXISTS idx_enrollments_slot
ON public.student_enrollments USING btree (slot_id);

CREATE OR REPLACE VIEW public.student_enrollment_details AS
SELECT
  e.id AS enrollment_id,
  e.student_id,
  u.full_name,
  u.email,
  e.slot_id,
  s.version_id,
  s.subject,
  s.section,
  s.day,
  s.slot_number,
  s.start_time,
  s.end_time,
  s.teacher_id,
  t.name AS teacher_name,
  s.room_id,
  r.name AS room_name,
  s.slot_type,
  s.col_span,
  e.locked_at
FROM public.student_enrollments e
JOIN public.users u ON u.id = e.student_id
JOIN public.timetable_slots s ON s.id = e.slot_id
LEFT JOIN public.timetable_teachers t ON t.id = s.teacher_id
LEFT JOIN public.rooms r ON r.id = s.room_id;

CREATE OR REPLACE FUNCTION public.save_student_schedule(
  p_student_id uuid,
  p_slot_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted_count integer := 0;
BEGIN
  IF p_student_id IS NULL THEN
    RAISE EXCEPTION 'student id is required';
  END IF;

  DELETE FROM public.student_enrollments
  WHERE student_id = p_student_id;

  INSERT INTO public.student_enrollments (student_id, slot_id)
  SELECT p_student_id, slot_id
  FROM unnest(COALESCE(p_slot_ids, ARRAY[]::uuid[])) AS slot_id
  WHERE slot_id IS NOT NULL
  ON CONFLICT (student_id, slot_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;
  RETURN v_inserted_count;
END;
$$;

GRANT SELECT ON public.student_enrollment_details TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_student_schedule(uuid, uuid[]) TO authenticated, service_role;

-- 5. SEMESTER TOKEN WALLET: free users get 100 tokens, pro users get 500 tokens per semester
CREATE TABLE IF NOT EXISTS public.user_semester_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  semester_key text NOT NULL,
  semester_label text NULL,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  tokens_awarded integer NOT NULL DEFAULT 100 CHECK (tokens_awarded >= 0),
  tokens_remaining integer NOT NULL DEFAULT 100 CHECK (tokens_remaining >= 0),
  generation_cost integer NOT NULL DEFAULT 100 CHECK (generation_cost > 0),
  generation_count integer NOT NULL DEFAULT 0 CHECK (generation_count >= 0),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_semester_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT user_semester_tokens_user_semester_key UNIQUE (user_id, semester_key),
  CONSTRAINT user_semester_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_semester_tokens_user
ON public.user_semester_tokens USING btree (user_id);

CREATE TABLE IF NOT EXISTS public.user_token_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  semester_key text NOT NULL,
  amount integer NOT NULL,
  reason text NOT NULL,
  balance_after integer NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_token_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT user_token_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_token_transactions_user_semester
ON public.user_token_transactions USING btree (user_id, semester_key, created_at DESC);

CREATE OR REPLACE FUNCTION public.ensure_user_semester_tokens(
  p_user_id uuid,
  p_semester_key text,
  p_semester_label text DEFAULT NULL
)
RETURNS TABLE (
  semester_key text,
  semester_label text,
  plan text,
  tokens_awarded integer,
  tokens_remaining integer,
  generation_cost integer,
  generation_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan text;
  v_allowance integer;
  v_topup integer;
  v_inserted public.user_semester_tokens%ROWTYPE;
  v_wallet public.user_semester_tokens%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id is required';
  END IF;

  IF NULLIF(trim(p_semester_key), '') IS NULL THEN
    RAISE EXCEPTION 'semester key is required';
  END IF;

  SELECT COALESCE(u.plan, 'free') INTO v_plan
  FROM public.users u
  WHERE u.id = p_user_id;

  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'student not found';
  END IF;

  IF v_plan <> 'pro' THEN
    v_plan := 'free';
  END IF;

  v_allowance := CASE WHEN v_plan = 'pro' THEN 500 ELSE 100 END;

  INSERT INTO public.user_semester_tokens (
    user_id,
    semester_key,
    semester_label,
    plan,
    tokens_awarded,
    tokens_remaining,
    generation_cost
  )
  VALUES (
    p_user_id,
    p_semester_key,
    COALESCE(p_semester_label, p_semester_key),
    v_plan,
    v_allowance,
    v_allowance,
    100
  )
  ON CONFLICT (user_id, semester_key) DO NOTHING
  RETURNING * INTO v_inserted;

  IF v_inserted.id IS NOT NULL THEN
    INSERT INTO public.user_token_transactions (
      user_id,
      semester_key,
      amount,
      reason,
      balance_after,
      metadata
    )
    VALUES (
      p_user_id,
      p_semester_key,
      v_allowance,
      'semester_allowance',
      v_allowance,
      jsonb_build_object('plan', v_plan, 'semester_label', COALESCE(p_semester_label, p_semester_key))
    );
  END IF;

  SELECT * INTO v_wallet
  FROM public.user_semester_tokens w
  WHERE w.user_id = p_user_id
    AND w.semester_key = p_semester_key
  FOR UPDATE;

  IF v_plan = 'pro' AND v_wallet.tokens_awarded < v_allowance THEN
    v_topup := v_allowance - v_wallet.tokens_awarded;

    UPDATE public.user_semester_tokens w
    SET
      plan = v_plan,
      semester_label = COALESCE(p_semester_label, w.semester_label),
      tokens_awarded = w.tokens_awarded + v_topup,
      tokens_remaining = w.tokens_remaining + v_topup,
      updated_at = now()
    WHERE w.id = v_wallet.id
    RETURNING * INTO v_wallet;

    INSERT INTO public.user_token_transactions (
      user_id,
      semester_key,
      amount,
      reason,
      balance_after,
      metadata
    )
    VALUES (
      p_user_id,
      p_semester_key,
      v_topup,
      'pro_semester_topup',
      v_wallet.tokens_remaining,
      jsonb_build_object('plan', v_plan, 'semester_label', COALESCE(p_semester_label, p_semester_key))
    );
  ELSE
    UPDATE public.user_semester_tokens w
    SET
      plan = v_plan,
      semester_label = COALESCE(p_semester_label, w.semester_label),
      updated_at = now()
    WHERE w.id = v_wallet.id
    RETURNING * INTO v_wallet;
  END IF;

  RETURN QUERY
  SELECT
    v_wallet.semester_key,
    v_wallet.semester_label,
    v_wallet.plan,
    v_wallet.tokens_awarded,
    v_wallet.tokens_remaining,
    v_wallet.generation_cost,
    v_wallet.generation_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_semester_token_status(
  p_user_id uuid,
  p_semester_key text,
  p_semester_label text DEFAULT NULL
)
RETURNS TABLE (
  semester_key text,
  semester_label text,
  plan text,
  tokens_awarded integer,
  tokens_remaining integer,
  generation_cost integer,
  generation_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.ensure_user_semester_tokens(p_user_id, p_semester_key, p_semester_label);
END;
$$;

CREATE OR REPLACE FUNCTION public.spend_schedule_generation_tokens(
  p_user_id uuid,
  p_semester_key text,
  p_semester_label text DEFAULT NULL,
  p_cost integer DEFAULT 100,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  semester_key text,
  semester_label text,
  plan text,
  tokens_awarded integer,
  tokens_remaining integer,
  generation_cost integer,
  generation_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet public.user_semester_tokens%ROWTYPE;
BEGIN
  IF p_cost IS NULL OR p_cost <= 0 THEN
    RAISE EXCEPTION 'token cost must be positive';
  END IF;

  PERFORM 1
  FROM public.ensure_user_semester_tokens(p_user_id, p_semester_key, p_semester_label);

  SELECT * INTO v_wallet
  FROM public.user_semester_tokens w
  WHERE w.user_id = p_user_id
    AND w.semester_key = p_semester_key
  FOR UPDATE;

  IF v_wallet.tokens_remaining < p_cost THEN
    RAISE EXCEPTION 'Not enough schedule tokens. You have %, but this generation needs %.', v_wallet.tokens_remaining, p_cost;
  END IF;

  UPDATE public.user_semester_tokens w
  SET
    tokens_remaining = w.tokens_remaining - p_cost,
    generation_count = w.generation_count + 1,
    updated_at = now()
  WHERE w.id = v_wallet.id
  RETURNING * INTO v_wallet;

  INSERT INTO public.user_token_transactions (
    user_id,
    semester_key,
    amount,
    reason,
    balance_after,
    metadata
  )
  VALUES (
    p_user_id,
    p_semester_key,
    -p_cost,
    'schedule_generation',
    v_wallet.tokens_remaining,
    COALESCE(p_metadata, '{}'::jsonb)
  );

  RETURN QUERY
  SELECT
    v_wallet.semester_key,
    v_wallet.semester_label,
    v_wallet.plan,
    v_wallet.tokens_awarded,
    v_wallet.tokens_remaining,
    v_wallet.generation_cost,
    v_wallet.generation_count;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_user_semester_tokens(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_semester_token_status(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.spend_schedule_generation_tokens(uuid, text, text, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_user_semester_tokens(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_semester_token_status(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.spend_schedule_generation_tokens(uuid, text, text, integer, jsonb) TO service_role;

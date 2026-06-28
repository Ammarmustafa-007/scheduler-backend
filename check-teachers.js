import { supabase } from './lib/supabase.js';

async function test() {
  const { data, error } = await supabase.from('timetable_teachers').select('*').limit(1);
  console.log('Teachers:', data);
  console.log('Error:', error);
}

test();

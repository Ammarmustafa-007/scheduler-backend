import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data, error } = await supabase.from('timetable_slots').select('section, subject');
  if (error) {
    console.error(error);
    return;
  }
  
  const sections = [...new Set(data.map(d => d.section))];
  console.log("ALL SECTIONS IN DB:");
  console.log(sections.sort().join('\n'));
}

run();

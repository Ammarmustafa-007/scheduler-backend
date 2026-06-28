import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
async function getTables() {
  const { data, error } = await supabase.from('information_schema.columns').select('*').eq('table_schema', 'public');
  if (error) console.error(error);
  else console.log(JSON.stringify(data, null, 2));
}
getTables();

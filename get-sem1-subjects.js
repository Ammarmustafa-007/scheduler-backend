import { supabase } from './lib/supabase.js';

async function check() {
  const { data: versions, error } = await supabase
    .from('timetable_versions')
    .select('id, version_label')
    .order('created_at', { ascending: false });

  if (error) {
    console.error("Error:", error);
    return;
  }
  
  if (!versions || versions.length === 0) {
    console.log("No versions found.");
    return;
  }

  console.log("Available Versions in Database:");
  versions.forEach(v => console.log(`- ID: ${v.id} | Label: '${v.version_label}'`));
}

check().catch(console.error);

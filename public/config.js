// Public connection settings for the browser app (see docs/SETUP.md, step 4).
// These two values are NOT secrets: the publishable/anon key can only do what
// the database's Row Level Security and functions allow, and every action
// requires a signed-in staff account.
// NEVER put the service_role / secret key or the database password here.
window.EAN_CONFIG = {
  url: 'https://mwhuehfwfmakecylmikt.supabase.co',
  key: 'sb_publishable_yfGel3ddS1T7UhLlUpbPaQ_zrlDOhFj'
};

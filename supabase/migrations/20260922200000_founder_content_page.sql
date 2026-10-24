insert into public.sellora_public_content (slug,title,seo_title,seo_description,draft_content,published_content,published,published_version)
values (
  'founder',
  'From the Founder',
  'From the Founder | Instaly',
  'A note from the founder of Instaly.',
  '{"eyebrow":"FROM THE FOUNDER","title":"A note from the founder.","intro":"A place to share the thinking, lessons and work behind Instaly.","photoUrl":"","photoAlt":"Founder","body":["Write your story here from Admin → Content. You can add as many paragraphs as you like."],"quote":"Build something useful enough that people want to come back.","sections":[{"heading":"What I am building","body":["Use this section for the ideas, decisions or progress you want to share."]}],"links":[],"signature":"— The founder"}',
  '{"eyebrow":"FROM THE FOUNDER","title":"A note from the founder.","intro":"A place to share the thinking, lessons and work behind Instaly.","photoUrl":"","photoAlt":"Founder","body":["Write your story here from Admin → Content. You can add as many paragraphs as you like."],"quote":"Build something useful enough that people want to come back.","sections":[{"heading":"What I am building","body":["Use this section for the ideas, decisions or progress you want to share."]}],"links":[],"signature":"— The founder"}',
  true,
  1
)
on conflict (slug) do nothing;

insert into storage.buckets (id, name, public)
values ('site-branding', 'site-branding', true)
on conflict (id) do update set public = true;
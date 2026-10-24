-- Keep paid email marketing and analytics integrations protected when clients use Supabase directly.
drop policy if exists "owners manage subscriber tags" on public.email_subscriber_tags;
create policy "entitled owners manage subscriber tags" on public.email_subscriber_tags
  for all to authenticated
  using (exists (select 1 from public.stores s where s.id = email_subscriber_tags.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'email_marketing')))
  with check (exists (select 1 from public.stores s where s.id = email_subscriber_tags.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'email_marketing')));

drop policy if exists "owners manage subscriber tag members" on public.email_subscriber_tag_members;
create policy "entitled owners manage subscriber tag members" on public.email_subscriber_tag_members
  for all to authenticated
  using (exists (select 1 from public.email_subscribers e join public.stores s on s.id = e.store_id where e.id = email_subscriber_tag_members.subscriber_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'email_marketing')))
  with check (exists (select 1 from public.email_subscribers e join public.stores s on s.id = e.store_id where e.id = email_subscriber_tag_members.subscriber_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'email_marketing')));

drop policy if exists "owners manage email segments" on public.email_segments;
create policy "entitled owners manage email segments" on public.email_segments
  for all to authenticated
  using (exists (select 1 from public.stores s where s.id = email_segments.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'email_marketing')))
  with check (exists (select 1 from public.stores s where s.id = email_segments.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'email_marketing')));

drop policy if exists "owners manage email campaigns" on public.email_campaigns;
create policy "entitled owners manage email campaigns" on public.email_campaigns
  for all to authenticated
  using (exists (select 1 from public.stores s where s.id = email_campaigns.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'email_marketing')))
  with check (exists (select 1 from public.stores s where s.id = email_campaigns.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'email_marketing')));

drop policy if exists "owners read campaign recipients" on public.email_campaign_recipients;
create policy "entitled owners read campaign recipients" on public.email_campaign_recipients
  for select to authenticated
  using (exists (select 1 from public.email_campaigns c join public.stores s on s.id = c.store_id where c.id = email_campaign_recipients.campaign_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'email_marketing')));

drop policy if exists "owners manage email automations" on public.email_automations;
create policy "entitled owners manage email automations" on public.email_automations
  for all to authenticated
  using (exists (select 1 from public.stores s where s.id = email_automations.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'email_marketing')))
  with check (exists (select 1 from public.stores s where s.id = email_automations.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'email_marketing')));

drop policy if exists "owners manage analytics integrations" on public.analytics_integrations;
create policy "entitled owners manage analytics integrations" on public.analytics_integrations
  for all to authenticated
  using (exists (select 1 from public.stores s where s.id = analytics_integrations.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'analytics_integrations')))
  with check (exists (select 1 from public.stores s where s.id = analytics_integrations.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'analytics_integrations')));
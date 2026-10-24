'use client';

import { useEffect, useState } from 'react';

export default function FounderContentTools({ token }: { token: string }) {
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');

  useEffect(() => {
    let active = true;
    void fetch('/api/admin?section=content', { headers: { Authorization: `Bearer ${token}` } })
      .then(response => response.json())
      .then(json => {
        const page = json.data?.pages?.find((item: any) => item.slug === 'founder');
        const url = page?.draft_content?.photoUrl;
        if (active && typeof url === 'string' && url) setPhotoUrl(url);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [token]);

  async function upload(file: File) {
    setUploading(true);
    setMessage('');
    try {
      const pagesResponse = await fetch('/api/admin?section=content', { headers: { Authorization: `Bearer ${token}` } });
      const pagesJson = await pagesResponse.json();
      if (!pagesResponse.ok) throw new Error(pagesJson.error || 'Could not load Founder content.');
      const page = pagesJson.data.pages.find((item: any) => item.slug === 'founder');
      if (!page) throw new Error('Founder page is not available yet. Run the latest database migration.');
      const form = new FormData();
      form.set('file', file);
      const uploadResponse = await fetch('/api/admin/content-media', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      const uploadJson = await uploadResponse.json();
      if (!uploadResponse.ok) throw new Error(uploadJson.error || 'Photo upload failed.');
      const content = { ...(page.draft_content || {}), photoUrl: uploadJson.url };
      const saveResponse = await fetch('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'save_public_content', slug: 'founder', title: page.title, seo_title: page.seo_title, seo_description: page.seo_description, content }) });
      const saveJson = await saveResponse.json();
      if (!saveResponse.ok) throw new Error(saveJson.error || 'Could not save Founder content.');
      setPhotoUrl(uploadJson.url);
      window.dispatchEvent(new CustomEvent('founder-photo-uploaded', { detail: { url: uploadJson.url } }));
      setMessage('Photo uploaded to the Founder draft. Publish the Founder page to make it public.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Photo upload failed.');
    } finally {
      setUploading(false);
    }
  }

  return <div className="card panel founder-admin-tools"><div>{photoUrl && <img className="founder-admin-photo" src={photoUrl} alt="Uploaded founder" />}<div className="eyebrow">FOUNDER MEDIA</div><h3>Upload your Founder photo</h3><p className="muted">This updates the Founder draft only. Use the JSON editor above for your headline, story, sections, links and signature, then publish when ready.</p>{photoUrl && <a href="/founder" target="_blank" className="form-link">Open Founder page ↗</a>}</div><label className="btn btn-primary"><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden disabled={uploading} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void upload(file); event.currentTarget.value = ''; }}/>{uploading ? 'Uploading…' : 'Choose photo'}</label>{message && <div className="info-note" style={{ gridColumn: '1 / -1' }}>{message}</div>}</div>;
}
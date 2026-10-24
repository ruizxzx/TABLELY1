import type { CSSProperties } from 'react';

export type SocialPlatform = {
  id: string;
  label: string;
  mark: string;
  color: string;
  base: string;
  placeholder: string;
  icon?: string;
};

export const SOCIAL_PLATFORMS: SocialPlatform[] = [
  { id: 'instagram', label: 'Instagram', mark: '◎', icon: 'instagram', color: '#e94d82', base: 'https://instagram.com/', placeholder: '@username' },
  { id: 'whatsapp', label: 'WhatsApp', mark: 'WA', color: '#25c866', base: 'https://wa.me/', placeholder: 'Phone number' },
  { id: 'tiktok', label: 'TikTok', mark: '♪', color: '#111217', base: 'https://tiktok.com/@', placeholder: '@username' },
  { id: 'youtube', label: 'YouTube', mark: '▶', color: '#f21f3f', base: 'https://youtube.com/@', placeholder: '@username' },
  { id: 'website', label: 'Website', mark: '◌', color: '#171811', base: 'https://', placeholder: 'yourwebsite.com' },
  { id: 'spotify', label: 'Spotify', mark: '●', color: '#1db954', base: 'https://open.spotify.com/user/', placeholder: 'Profile or playlist URL' },
  { id: 'threads', label: 'Threads', mark: '@', color: '#34343a', base: 'https://threads.net/@', placeholder: '@username' },
  { id: 'facebook', label: 'Facebook', mark: 'f', color: '#1877f2', base: 'https://facebook.com/', placeholder: 'Username or URL' },
  { id: 'x', label: 'Twitter / X', mark: 'X', color: '#111217', base: 'https://x.com/', placeholder: '@username' },
  { id: 'soundcloud', label: 'SoundCloud', mark: '≋', color: '#ff6a00', base: 'https://soundcloud.com/', placeholder: 'Username or URL' },
  { id: 'snapchat', label: 'Snapchat', mark: 'S', color: '#f4e400', base: 'https://snapchat.com/add/', placeholder: 'Username' },
  { id: 'pinterest', label: 'Pinterest', mark: 'P', color: '#e60023', base: 'https://pinterest.com/', placeholder: 'Username or URL' },
  { id: 'patreon', label: 'Patreon', mark: 'P', color: '#ff5a5f', base: 'https://patreon.com/', placeholder: 'Username or URL' },
  { id: 'twitch', label: 'Twitch', mark: '▣', color: '#9146ff', base: 'https://twitch.tv/', placeholder: 'Username or URL' },
  { id: 'applemusic', label: 'Apple Music', mark: '♪', color: '#fa4567', base: 'https://music.apple.com/', placeholder: 'Profile or playlist URL' },
  { id: 'linkedin', label: 'LinkedIn', mark: 'in', color: '#0a66c2', base: 'https://linkedin.com/in/', placeholder: 'Username or URL' },
  { id: 'github', label: 'GitHub', mark: '◖', color: '#24292f', base: 'https://github.com/', placeholder: 'Username or URL' },
  { id: 'telegram', label: 'Telegram', mark: '➤', color: '#27a7e7', base: 'https://t.me/', placeholder: 'Username or URL' },
  { id: 'discord', label: 'Discord', mark: '☯', color: '#5865f2', base: 'https://discord.com/users/', placeholder: 'Username or URL' },
  { id: 'twitter', label: 'Twitter', mark: '♥', color: '#1da1f2', base: 'https://twitter.com/', placeholder: '@username' },
  { id: 'dribbble', label: 'Dribbble', mark: '●', color: '#ea4c89', base: 'https://dribbble.com/', placeholder: 'Username or URL' },
];

export function getSocialPlatform(id: string) {
  if (id === 'youtube_music') return { id, label: 'YouTube Music', mark: '▶', color: '#ff0000', base: 'https://music.youtube.com/', placeholder: 'YouTube Music URL' };
  return SOCIAL_PLATFORMS.find(platform => platform.id === id) || SOCIAL_PLATFORMS.find(platform => platform.id === 'website')!;
}

export function inferSocialPlatform(value: string, label = '') {
  const haystack = `${value} ${label}`.toLowerCase();
  const matches = SOCIAL_PLATFORMS.filter(platform => platform.id !== 'website').sort((a, b) => b.id.length - a.id.length);
  return matches.find(platform => haystack.includes(platform.id) || (platform.id === 'x' && /(^|\W)x\.com/.test(haystack)))?.id || 'website';
}

export function SocialIcon({ platform, size = 'md' }: { platform: string; size?: 'sm' | 'md' | 'lg' }) {
  const item = getSocialPlatform(platform);
  const iconSlugs: Record<string, string> = { instagram: 'instagram', whatsapp: 'whatsapp', tiktok: 'tiktok', youtube: 'youtube', youtube_music: 'youtube-music', spotify: 'spotify', threads: 'threads', facebook: 'facebook', x: 'x', soundcloud: 'soundcloud', snapchat: 'snapchat', pinterest: 'pinterest', patreon: 'patreon', twitch: 'twitch', applemusic: 'applemusic', linkedin: 'linkedin', github: 'github', telegram: 'telegram', discord: 'discord', twitter: 'twitter', dribbble: 'dribbble' };
  const iconSlug = iconSlugs[item.id];
  const youtubeMusicMark = item.id === 'youtube_music' ? <span className="social-youtube-music-mark"><span /></span> : null;
  return <span className={`social-brand-icon social-brand-${item.id} social-brand-${size}`} style={{ '--social-color': item.color } as CSSProperties} aria-hidden="true">{youtubeMusicMark || (iconSlug ? <img src={`https://cdn.simpleicons.org/${iconSlug}/ffffff`} alt="" /> : item.mark)}</span>;
}

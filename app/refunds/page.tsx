import type {Metadata} from 'next';import {getPublishedContent} from '../lib/public-content';import LegalPage from '../components/LegalPage';
export const dynamic='force-dynamic';
export async function generateMetadata():Promise<Metadata>{const c=await getPublishedContent('refunds');return {title:c?.seo_title||'Refunds',description:c?.seo_description||'TABLELY refunds'};}
export default async function Page(){const content=await getPublishedContent('refunds');return <LegalPage content={content||{title:'Unavailable',content:{sections:[{heading:'Content unavailable',body:'Please try again later.'}]}}}/>}

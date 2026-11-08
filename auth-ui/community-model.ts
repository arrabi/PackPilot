export const regularMeetings = ['2026-09-16', '2026-09-30', '2026-10-14', '2026-10-28', '2026-11-11', '2026-11-25', '2026-12-09', '2026-12-23', '2027-01-06', '2027-01-20', '2027-02-03', '2027-03-31', '2027-04-14', '2027-04-28', '2027-05-12', '2027-05-26'];
export const dens = ['0-Lions', '1-Tigers', '2-Wolves', '3-Bears', '4-Webelos', '5-AOL'];
export interface CommunityEvent {
    created_at?:string|null;
    id: string;
    title: string;
    event_type?: string;
    location?: string;
    event_date: string;
    start_time?:string|null;end_time?:string|null;end_date?:string|null;timezone?:string;rsvp_deadline?:string|null;rsvp_deadline_local?:string|null;
    going_count?:number;declined_count?:number;
    den: string | null;
    details: string;
    rsvp_mode: string;
    capacity: number | null;
    used: number;
    cancelled: boolean;
    revision: number;
}
export interface Meeting {
    id: string;
    meeting_date: string;
    event_id?: string|null;
    created_by?: string;
    created_by_name?:string;attendance_activity_id?:string|null;
    recorded_by?: string;
    den: string | null;
    pack_activity: string;
    agenda: string;
    supplies: string;
    requirements: {
        adventure_id: string;
        code: string;
    }[];
    revision: number;
}
export interface CommunityData {
    signups?:import('./volunteer-signups.ts').VolunteerSignup[];
    leader: boolean;
    can_record: boolean;
    scouts: {
        id: string;
        name: string;
        den: string;
    }[];
    events: CommunityEvent[];
    responses?:{event_id:string;scout_id:string;response:'going'|'not_going'}[];
    bookings: {
        event_id: string;
        scout_id: string;
        others: number;
    }[];
    jobs: {
        created_at?:string|null;
        signup_date?: string|null;
        signup_id?:string;
        capacity_unit?:'family'|'person';my_note?:string|null;on_waitlist?:boolean;waitlist_count?:number;can_edit_note?:boolean;family_commitment_count?:number;
        id: string;
        title: string;
        details: string;
        event_id: string | null;
        capacity: number | null;
        used: number;
        mine: boolean;
        closed: boolean;
    }[];
    volunteers: {
        job_id: string;
        scout_id: string;
        name: string;note?:string;
    }[];
    waitlist?:{job_id:string;scout_id:string;name:string;note:string;requested_at:string}[];
    meetings: Meeting[];
    photos: {
        scout_id: string;
        kind: string;
        image: string;
    }[];
    adventures: {
        id: string;
        name: string;
        rank: string;
        catalog_context?: {adventure_type?:string};
        source_url?:string;
        completion_groups?:unknown;
        program_version?:string;
        requirements: {
            code: string;
            description: string;
        }[];
    }[];
}
export function remaining(e: {
    capacity: number | null;
    used: number;
}) { return e.capacity === null ? 'Unlimited places' : `${Math.max(0, e.capacity - e.used)} of ${e.capacity} places remaining`; }
export async function preparePhoto(file: File): Promise<string> {
    if (!file.type.startsWith('image/') || file.size > 15 * 1024 * 1024)
        throw Error('Choose an image smaller than 15 MB.');
    const bitmap = await createImageBitmap(file);
    try {
        const canvas = document.createElement('canvas'), scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const result = canvas.toDataURL('image/jpeg', 0.75);
        if (result.length > 180000)
            throw Error('Choose a smaller or simpler image.');
        return result;
    }
    finally {
        bitmap.close();
    }
}

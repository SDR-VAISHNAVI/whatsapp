// SupabaseStore — session persistence keyed by owner_id.
//
// FIX: Previously this class used 'id' (text) as the session key, which
// conflicted with server.js using 'owner_id' (int). Both are now aligned:
// every operation looks up rows by owner_id and the status column is
// written so that logged-out sessions can be excluded from reconnect queries.
//
// NOTE: This class is wired into server.js via connectWhatsApp() — it is
// no longer an orphaned export.

class SupabaseStore {
    constructor(supabase) {
        this.supabase = supabase;
    }

    // ownerId: integer owner PK
    async sessionExists(ownerId) {
        const { data } = await this.supabase
            .from('whatsapp_sessions')
            .select('owner_id')
            .eq('owner_id', ownerId)
            .neq('status', 'logged_out')
            .maybeSingle();
        return !!data;
    }

    async save(ownerId, sessionJson) {
        const { error } = await this.supabase
            .from('whatsapp_sessions')
            .upsert({
                owner_id:   ownerId,
                session:    sessionJson,
                status:     'active',
                updated_at: new Date().toISOString()
            }, { onConflict: 'owner_id' });
        if (error) throw error;
    }

    async load(ownerId) {
        const { data, error } = await this.supabase
            .from('whatsapp_sessions')
            .select('session')
            .eq('owner_id', ownerId)
            .neq('status', 'logged_out')
            .maybeSingle();
        if (error || !data) return null;
        return data.session;
    }

    async delete(ownerId) {
        await this.supabase
            .from('whatsapp_sessions')
            .delete()
            .eq('owner_id', ownerId);
    }

    async markLoggedOut(ownerId) {
        const { error } = await this.supabase
            .from('whatsapp_sessions')
            .update({ status: 'logged_out', updated_at: new Date().toISOString() })
            .eq('owner_id', ownerId);
        if (error) throw error;
    }

    async getActiveOwnerIds() {
        const { data, error } = await this.supabase
            .from('whatsapp_sessions')
            .select('owner_id')
            .neq('status', 'logged_out');
        if (error) throw error;
        return (data || []).map(r => r.owner_id);
    }
}

module.exports = SupabaseStore;

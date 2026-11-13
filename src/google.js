import { HttpError, encrypt, decrypt, token, hash } from './security.js';
export const GOOGLE_SCOPES = ['openid','email','https://www.googleapis.com/auth/calendar.events.owned','https://www.googleapis.com/auth/calendar.events.freebusy','https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
export class GoogleError extends Error { constructor(status, code) {super('Google Calendar request failed.');this.status=status;this.code=code;} }
export class GoogleCalendar {
  constructor(db,config,fetcher=fetch) {this.db=db;this.config=config;this.fetcher=fetcher;}
  account() { return this.db.prepare('SELECT * FROM google_account WHERE id=1').get(); }
  configured() {return Boolean(this.config.googleClientId && this.config.googleClientSecret);}
  async request(url, options={}) {
    let response;
    try {response=await this.fetcher(url,{...options,signal:AbortSignal.timeout(12000)});} catch {throw new GoogleError(0,'network_error');}
    const body=await response.json().catch(()=>({}));
    if (!response.ok) throw new GoogleError(response.status,typeof body.error==='string'?body.error:body.error?.status || 'api_error');
    return body;
  }
  async accessToken() {
    const a=this.account(); if(!a)throw new HttpError(503,'The host has not connected Google Calendar yet.','calendar_unavailable');
    if (this.cachedAccess?.source===a.refresh_token && this.cachedAccess.expires>Date.now()+60000) return this.cachedAccess.value;
    const result=await this.request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.config.googleClientId,client_secret:this.config.googleClientSecret,refresh_token:decrypt(a.refresh_token,this.config.encryptionKey),grant_type:'refresh_token'})});
    if(!result.access_token)throw new GoogleError(502,'missing_access_token');
    this.cachedAccess={source:a.refresh_token,value:result.access_token,expires:Date.now()+Math.max(60,Number(result.expires_in)||3600)*1000};
    return result.access_token;
  }
  async api(path,options={}) {
    const access=await this.accessToken();
    return this.request(`https://www.googleapis.com/calendar/v3${path}`,{...options,headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json',...options.headers}});
  }
  beginOAuth(sessionHash) {
    if(!this.configured())throw new HttpError(503,'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your deployment first.');
    if(typeof sessionHash!=='string' || !sessionHash)throw new HttpError(401,'Sign in as the host first.');
    const state=token(), verifier=token();
    this.db.prepare('DELETE FROM oauth_states WHERE expires < ?').run(Date.now());
    this.db.prepare('INSERT INTO oauth_states(state_hash,verifier,session_hash,expires) VALUES(?,?,?,?)').run(hash(state),encrypt(verifier,this.config.encryptionKey),sessionHash,Date.now()+600000);
    const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search=new URLSearchParams({client_id:this.config.googleClientId,redirect_uri:`${this.config.appUrl}/auth/google/callback`,response_type:'code',scope:GOOGLE_SCOPES.join(' '),access_type:'offline',prompt:'consent',include_granted_scopes:'true',state,code_challenge:Buffer.from(hash(verifier),'hex').toString('base64url'),code_challenge_method:'S256'}).toString();
    return url.href;
  }
  async completeOAuth(state,code,sessionHash) {
    if(typeof state!=='string' || !state || typeof code!=='string' || !code || typeof sessionHash!=='string' || !sessionHash)throw new HttpError(400,'Invalid Google connection request.');
    const row=this.db.prepare('DELETE FROM oauth_states WHERE state_hash=? AND session_hash=? AND expires>=? RETURNING *').get(hash(state),sessionHash,Date.now());
    if(!row)throw new HttpError(400,'The Google connection request expired. Please try again.');
    const tokens=await this.request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.config.googleClientId,client_secret:this.config.googleClientSecret,code,code_verifier:decrypt(row.verifier,this.config.encryptionKey),redirect_uri:`${this.config.appUrl}/auth/google/callback`,grant_type:'authorization_code'})});
    if(!tokens.access_token)throw new GoogleError(502,'missing_access_token');
    const user=await this.request('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${tokens.access_token}`}});
    if(user.email_verified!==true || typeof user.sub!=='string' || !user.sub || typeof user.email!=='string' || !user.email)throw new HttpError(403,'Use a verified Google account.');
    if(this.config.ownerGoogleEmail && user.email.toLowerCase()!==this.config.ownerGoogleEmail)throw new HttpError(403,'That Google account is not allowed for this deployment.');
    const old=this.account();
    if(old && old.sub!==user.sub)throw new HttpError(409,'Disconnect the previous Google account before connecting another.');
    const granted=new Set((tokens.scope||'').split(' '));
    if(!GOOGLE_SCOPES.filter(s=>s.startsWith('https:')).every(s=>granted.has(s)))throw new HttpError(403,'Please grant the requested Calendar permissions.');
    const refresh=tokens.refresh_token ? encrypt(tokens.refresh_token,this.config.encryptionKey) : old?.refresh_token;
    if(!refresh)throw new HttpError(400,'Google did not return offline access. Reconnect and accept the requested permissions.');
    this.db.prepare(`INSERT INTO google_account(id,sub,email,refresh_token,calendar_id,conflict_calendars) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sub=excluded.sub,email=excluded.email,refresh_token=excluded.refresh_token`).run(user.sub,user.email,refresh,old?.calendar_id||'primary',old?.conflict_calendars||'["primary"]');
  }
  async freeBusy(start,end,extraCalendarIds=[]) {
    const a=this.account(); if(!a)throw new HttpError(503,'Google Calendar is not connected.');
    const ids=[...new Set([a.calendar_id,...JSON.parse(a.conflict_calendars),...extraCalendarIds])];
    const busy=[];
    for(let offset=0;offset<ids.length;offset+=50) {
    const batch=ids.slice(offset,offset+50);
    const result=await this.api('/freeBusy',{method:'POST',body:JSON.stringify({timeMin:new Date(start).toISOString(),timeMax:new Date(end).toISOString(),calendarExpansionMax:50,items:batch.map(id=>({id}))})});
    for(const id of batch) {
      const calendar=result.calendars?.[id];
      if(!calendar || calendar.errors?.length || !Array.isArray(calendar.busy))throw new GoogleError(503,'freebusy_incomplete');
      for(const b of calendar.busy) {
        const start=Date.parse(b.start),end=Date.parse(b.end);
        if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end)throw new GoogleError(503,'invalid_freebusy');
        busy.push({start,end});
      }
    }
    }
    return busy;
  }
  async calendars() {
    let pageToken,items=[];
    do {
      const result=await this.api(`/users/me/calendarList?maxResults=250${pageToken?`&pageToken=${encodeURIComponent(pageToken)}`:''}`);
      items.push(...(result.items||[])); pageToken=result.nextPageToken;
    } while(pageToken && items.length<1000);
    return items.map(c=>({id:c.id,summary:c.summary,primary:Boolean(c.primary),accessRole:c.accessRole,conferenceAllowed:c.conferenceProperties?.allowedConferenceSolutionTypes?.includes('hangoutsMeet')||false}));
  }
  async insert(booking) {
    return this.api(`/calendars/${encodeURIComponent(booking.calendar_id)}/events?conferenceDataVersion=1&sendUpdates=all`,{method:'POST',body:JSON.stringify({
      id:booking.google_event_id, summary:`${booking.title} · ${booking.name}`,
      description:`Booked through Meetly.\n\nGuest: ${booking.name}\nGuest timezone: ${booking.timezone}${booking.notes?`\n\nGuest notes:\n${booking.notes}`:''}`,
      start:{dateTime:new Date(booking.start).toISOString(),timeZone:booking.host_timezone},
      end:{dateTime:new Date(booking.end).toISOString(),timeZone:booking.host_timezone},
      attendees:[{email:booking.email,displayName:booking.name}],
      conferenceData:{createRequest:{requestId:booking.google_event_id,conferenceSolutionKey:{type:'hangoutsMeet'}}},
      extendedProperties:{private:{meetlyBookingId:booking.id}},transparency:'opaque'
    })});
  }
  async get(booking) {return this.api(`/calendars/${encodeURIComponent(booking.calendar_id)}/events/${booking.google_event_id}`);}
  async remove(booking) {
    const access=await this.accessToken();
    let response;
    try {response=await this.fetcher(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(booking.calendar_id)}/events/${booking.google_event_id}?sendUpdates=all`,{method:'DELETE',headers:{Authorization:`Bearer ${access}`},signal:AbortSignal.timeout(12000)});} catch {throw new GoogleError(0,'network_error');}
    if(!response.ok && ![404,410].includes(response.status))throw new GoogleError(response.status,'delete_failed');
  }
}

# Navigation and data freshness

Today and historical days reuse card elements when their manifest ID and
renderer stay the same. Changing the day projects that day's entries from
loaded history. It closes an unsaved dated form; a save already submitted
keeps the date and payload captured when it started.

Ordinary card history is shared with combination cards, the calendar and
daily prompts. Compatible simultaneous reads share one request. Successful
reads stay fresh for 20 seconds. A later date change, remount or return to
the app refreshes expired history. Relevant data and metadata change events
invalidate affected reads.

A successful save requires acknowledgement from the server before its
snapshot enters the shared cache. Other mounted readers can adopt that
confirmed snapshot without another history request. Failed saves preserve
the last confirmed data and report an error.

Selected Health Connect readings use separate, uncached projection reads.
They retain their selection checks and refresh behavior; an ordinary cache
entry cannot substitute for a selected projection.

Shared GET reads pause after HTTP 429. They honor `Retry-After` seconds or
HTTP dates, with a one-second fallback when the header is absent or invalid.
Readers make at most one automatic recovery request per refresh. A locally
blocked attempt waits for an extended deadline without spending that request.
A date change or return to the app can trigger a later refresh.

Confirmed ordinary values stay visible during temporary read failures, with
a status message where the card or view needs an update. Editing waits for
a successful refresh. Writes are never automatically replayed.

The navigation, shared-read and throttling browser regressions measure API
GET counts as well as checking displayed data, element identity, save races,
cache expiry and recovery. Their fixtures are synthetic.

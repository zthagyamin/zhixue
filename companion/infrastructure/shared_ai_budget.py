"""Read additive owner-wide reservations without creating another service's tables."""

def reservation_totals(db, owner, day, since, *, exclude=None):
    count = tokens = active = 0
    present = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if exclude != 'course' and 'native_course_requests' in present:
        n, t = db.execute('SELECT count(*),COALESCE(sum(reserved),0) FROM native_course_requests '
                          'WHERE owner=? AND budget_day=? AND reserved>0', (owner, day)).fetchone()
        count += n; tokens += t
        if 'native_course_attempts' in present:
            active += db.execute("SELECT count(*) FROM native_course_requests r JOIN native_course_attempts a "
                "ON a.owner=r.owner AND a.library=r.library AND a.root=r.root AND a.active_request=r.request_id "
                "WHERE r.owner=? AND r.reserved>0 AND r.state='inflight' AND a.started>=?", (owner, since)).fetchone()[0]
    if exclude != 'math' and 'native_math_budget' in present:
        n, t = db.execute('SELECT count(*),COALESCE(sum(reserved),0) FROM native_math_budget '
                          'WHERE owner=? AND day=? AND reserved>0', (owner, day)).fetchone()
        count += n; tokens += t
        active += db.execute("SELECT count(*) FROM native_math_budget WHERE owner=? AND reserved>0 "
                             "AND state='inflight' AND started>=?", (owner, since)).fetchone()[0]
    if exclude != 'code' and 'nonword_code_budget' in present:
        n, t = db.execute('SELECT count(*),COALESCE(sum(reserved),0) FROM nonword_code_budget '
                          'WHERE owner=? AND day=? AND reserved>0', (owner, day)).fetchone()
        count += n; tokens += t
        active += db.execute("SELECT count(*) FROM nonword_code_budget WHERE owner=? AND reserved>0 "
                             "AND state='inflight' AND started>=?", (owner, since)).fetchone()[0]
    if exclude != 'recall' and 'nonword_recall_budget' in present:
        n, t = db.execute('SELECT count(*),COALESCE(sum(reserved),0) FROM nonword_recall_budget '
                          'WHERE owner=? AND day=? AND reserved>0', (owner, day)).fetchone()
        count += n; tokens += t
        active += db.execute("SELECT count(*) FROM nonword_recall_budget WHERE owner=? AND reserved>0 "
                             "AND state='inflight' AND started>=?", (owner, since)).fetchone()[0]
    if exclude != 'hint' and 'nonword_hint_budget' in present:
        n, t = db.execute('SELECT count(*),COALESCE(sum(reserved),0) FROM nonword_hint_budget '
                          'WHERE owner=? AND day=? AND reserved>0', (owner, day)).fetchone()
        count += n; tokens += t
        active += db.execute("SELECT count(*) FROM nonword_hint_budget WHERE owner=? AND reserved>0 "
                             "AND state='inflight' AND started>=?", (owner, since)).fetchone()[0]
    if exclude != 'chat' and 'study_chat_budget' in present:
        n, t = db.execute('SELECT count(*),COALESCE(sum(reserved),0) FROM study_chat_budget '
                          'WHERE owner=? AND day=? AND reserved>0', (owner, day)).fetchone()
        count += n; tokens += t
        active += db.execute("SELECT count(*) FROM study_chat_budget WHERE owner=? AND reserved>0 "
                             "AND state='inflight'", (owner,)).fetchone()[0]
    return count, tokens, active

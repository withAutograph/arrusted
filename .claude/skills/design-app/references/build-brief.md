# Section brief (`app/features/<section>/BRIEF.md`)

A short, plain-language record kept in step with the prototype. It is for the
builder and for the `add-section` skill. Update it silently on each revision;
never ask the builder to approve it as a document.

Label material choices so defaults are not mistaken for decisions:
**said** (the builder stated it), **default** (Claude chose it, revisable),
**deferred** (explicitly not in the first version), **open** (unresolved).

```markdown
# <Section name>

## Who and why
Primary user, what they do first, what "working" looks like.

## Pages
Each page, what it is for, and how you get there. Note which ones could just be
Canvas (seeing and editing one table's rows) and which need a custom page.
Note that Canvas cannot yet create new records or import CSV; a section that
needs either needs a small custom form for now.

## Things it keeps track of
For each: name, what tells two apart, the details needed to act (required)
versus nice to have (optional), choice lists with their options in order,
and links ("each deal belongs to one company").
Say which existing table each maps to, or which domain-libs starter it is
modeled on (for example "People,
already in the app" or "modeled on the Customer starter").

## Who can see and change what
Default: everyone signed in sees the whole section. Note any exception.

## Actions and what they do for real
Each visible action, what it will change once real, and anything that sends,
pays or notifies (and who confirms it).

## Claude over MCP
Read only, propose drafts, or make changes.

## Getting data in
CSV import, typing, or a later integration.

## Deferred and open
Illustrative features not in the first version; any unresolved question.
```

Ready for "build this" when: every thing tracked has an identity, required
fields and links; access and irreversible actions are settled or explicitly
defaulted; and each visible element is either real or marked deferred.

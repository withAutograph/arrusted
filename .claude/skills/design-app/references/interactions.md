# Prototype interactions

A prototype lets the builder judge the workflow, not just the arrangement.
All behavior runs on sample data in memory.

## Every visible control has a result

For each control (buttons, row links, nav items, menus, dialogs, tabs,
filters, forms, keyboard actions) know:

- when it is enabled;
- what visibly happens;
- how cancel or dismiss behaves;
- what validation or error looks like;
- why it is unavailable, if the prototype cannot support it.

Disable what cannot work and give a product-facing reason. Never ship no-op
handlers, empty links, dead routes or fake success messages.

## Routes and state

- Use the app's normal Next.js routes for the section's pages and the shared
  navigation, so Back/Forward and direct visits work.
- Keep the selected nav item, visible page, URL and in-memory state in
  agreement. A direct visit to any prototype route renders coherent state.
- Hold shared sample-data state in the section layout (or a context there) so
  every page shows the same facts and edits survive navigation within the
  session.
- When an action changes data, update every dependent count, total, badge,
  list, selection and next action in the same interaction. A toast is extra
  feedback, not the result.

## Forms and consequential actions

- Forms accept input, validate required and invalid values next to the field,
  keep entered values on error, submit to a visible change, and cancel without
  committing anything.
- Consequential actions (approve, send, pay, notify) are simulated and labeled
  as such. Never imply an email went out or money moved.
- Keep resulting states precise: acknowledging is not resolving; choosing a
  recommendation is not completing it.

Examples:

- **Add a deal:** a valid submit adds the row, updates the stage count and
  pipeline total, and the deal appears wherever deals are chosen. Cancel
  changes nothing. Missing company shows a field error.
- **Move a deal to Won:** the deal leaves the open list, the won total and the
  rep's open count change together.
- **Log a call:** the activity appears on the person and on the deal, newest
  first.

## Before showing a revision

Click through every enabled control in the browser, not only the happy path:

1. each navigation action lands on the right page;
2. Back and Forward restore page and selection;
3. edits and totals stay consistent across pages;
4. forms validate, submit and cancel as described;
5. menus and dialogs open, take focus, and close (including Escape);
6. empty and error states explain the next useful step;
7. nothing enabled is inert or pretends to call a live system.

If you could not exercise something, say so plainly instead of claiming it
works.

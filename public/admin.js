import { $, element, api, button, feedback, submit, priceLabel, monthLabel, dateLabel } from './common.js';

const loginForm = $('#login');
const dashboard = $('#dashboard');
const eventForm = $('#event-form');
const notice = $('#admin-message');
const states = { new: 'Новая', progress: 'В работе', closed: 'Закрыта' };
let data;
let editing = null;
let inboxType = 'all';

function setLogin(visible) {
  loginForm.hidden = !visible;
  dashboard.hidden = visible;
  $('#logout').hidden = visible;
}
async function refresh() {
  data = await api('admin/data');
  const format = eventForm.elements.category;
  const current = format.value;
  format.replaceChildren(...Object.entries(data.kinds).map(([key, [label]]) => new Option(label, key)));
  if (current) format.value = current;
  renderEvents();
  renderPolls();
  renderInbox();
  setLogin(false);
}
function showError(error) {
  feedback(notice, error.status ? error.message : 'Нет связи с сервером. Попробуй ещё раз.', true);
  if (error.status === 401) {
    data = null;
    setLogin(true);
  }
}
loginForm.addEventListener('submit', event => {
  event.preventDefault();
  submit(loginForm, async values => {
    await api('admin/login', values);
    loginForm.reset();
    feedback(loginForm.querySelector('.form-status'), '');
    feedback(notice, '');
    await refresh();
    dashboard.querySelector('button').focus();
  });
});
$('#logout').addEventListener('click', async () => {
  try {
    await api('admin/logout', {});
    feedback(notice, '');
    setLogin(true);
    data = null;
    resetEvent();
    for (const id of ['#admin-events', '#admin-polls', '#admin-inbox']) $(id).replaceChildren();
    loginForm.elements.login.focus();
  } catch (error) {
    showError(error);
  }
});
for (const tab of dashboard.querySelectorAll('[data-tab]')) {
  tab.addEventListener('click', () => {
    for (const candidate of dashboard.querySelectorAll('[data-tab]')) candidate.setAttribute('aria-pressed', String(candidate === tab));
    for (const panel of dashboard.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    if (tab.dataset.tab === 'inbox' || tab.dataset.tab === 'polls') refresh().catch(showError);
  });
}
function resetEvent() {
  eventForm.reset();
  editing = null;
  $('#edit-title').textContent = 'Новое событие';
  $('#event-reset').hidden = true;
  feedback(eventForm.querySelector('.form-status'), '');
}
$('#event-reset').addEventListener('click', resetEvent);
function editEvent(event) {
  editing = event.id;
  $('#edit-title').textContent = 'Редактировать событие';
  $('#event-reset').hidden = false;
  for (const key of ['title', 'day', 'time', 'category', 'price', 'room', 'description']) eventForm.elements[key].value = event[key];
  for (const key of ['published', 'demo']) eventForm.elements[key].checked = Boolean(event[key]);
  feedback(eventForm.querySelector('.form-status'), '');
  eventForm.elements.title.focus();
}
function renderEvents() {
  const list = $('#admin-events');
  list.replaceChildren(element('h2', '', 'События · ' + data.events.length));
  for (const event of data.events) {
    const card = element('article', 'admin-card');
    card.append(
      element('h3', '', event.title),
      element('p', '', dateLabel(event.day) + ' · ' + event.time + ' · ' + event.room + ' · ' + priceLabel(event.price)),
      element('p', 'form-hint', (event.published ? 'Опубликовано' : 'Черновик') + (event.demo ? ' · Демо' : '')),
      button('Редактировать', 'button light-outline', () => editEvent(event)),
    );
    list.append(card);
  }
}
eventForm.addEventListener('submit', event => {
  event.preventDefault();
  submit(eventForm, async (values, status) => {
    await api('admin/event', {
      ...values, id: editing, price: Number(values.price), published: Boolean(values.published), demo: Boolean(values.demo),
    });
    resetEvent();
    feedback(status, 'Событие сохранено.');
    await refresh();
  });
});
$('#poll-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  submit(form, async ({ month, labels }, status) => {
    await api('admin/poll', { month, labels: labels.split('\n').map(label => label.trim()).filter(Boolean) });
    form.reset();
    feedback(status, 'Голосование открыто.');
    await refresh();
  });
});
function renderPolls() {
  const list = $('#admin-polls');
  list.replaceChildren(element('h2', '', 'Результаты'), ...(data.polls.length ? [] : [element('p', '', 'Голосований пока нет.')]));
  for (const poll of data.polls) {
    const card = element('article', 'admin-card');
    const options = element('ul');
    const total = poll.choices.reduce((sum, choice) => sum + choice.count, 0);
    for (const choice of [...poll.choices].sort((a, b) => b.count - a.count)) {
      const percent = total ? Math.round(choice.count * 100 / total) : 0;
      options.append(element('li', '', choice.label + ' — ' + choice.count + ' (' + percent + '%)'));
    }
    card.append(
      element('h3', 'poll-month', monthLabel(poll.month)),
      element('p', 'form-hint', (poll.open ? 'Открыто' : 'Завершено') + ' · Всего голосов — ' + total + (poll.demo ? ' · Демо' : '')),
      options,
    );
    if (poll.open) {
      card.append(button('Закрыть голосование', 'button light-outline', async event => {
        if (!window.confirm('Закрыть приём голосов за ' + monthLabel(poll.month) + '?')) return;
        event.currentTarget.disabled = true;
        try {
          await api('admin/poll/close', { id: poll.id });
          await refresh();
          feedback(notice, 'Голосование закрыто.');
        } catch (error) {
          showError(error);
        } finally {
          const control = card.querySelector('button');
          if (control) control.disabled = false;
        }
      }));
    }
    list.append(card);
  }
}
const inboxTypes = $('#inbox-types');
for (const [key, label] of [['all', 'Все заявки'], ['booking', 'Запись на событие'], ['partner', 'Предложения']]) {
  const control = button(label, 'chip', () => {
    inboxType = key;
    for (const option of inboxTypes.children) option.setAttribute('aria-pressed', String(option === control));
    renderInbox();
  });
  control.setAttribute('aria-pressed', String(inboxType === key));
  inboxTypes.append(control);
}
$('#inbox-status').addEventListener('change', renderInbox);
function renderInbox() {
  const status = $('#inbox-status').value;
  const selected = data.requests.filter(request => (inboxType === 'all' || request.kind === inboxType) && (status === 'all' || request.status === status));
  const list = $('#admin-inbox');
  list.replaceChildren(element('p', 'sample', 'Заявок — ' + selected.length));
  for (const request of selected) {
    const card = element('article', 'admin-card');
    const isBooking = request.kind === 'booking';
    const received = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(new Date(request.created.replace(' ', 'T') + 'Z'));
    card.append(
      element('h3', '', isBooking ? request.event_title : 'Предложение организатора'),
      element('p', 'form-hint', 'Получено ' + received + ' · ' + states[request.status]),
      element('p', '', request.name + ' · ' + request.contact),
      element('p', isBooking ? '' : 'request-message', isBooking ? dateLabel(request.event_day) + ' · Участников — ' + request.guests : request.message),
    );
    const row = element('div', 'admin-control-row');
    const select = element('select');
    select.setAttribute('aria-label', 'Статус заявки ' + request.id);
    select.replaceChildren(...Object.entries(states).map(([key, label]) => new Option(label, key, false, key === request.status)));
    const change = button('Сохранить статус', 'button light-outline', async () => {
      change.disabled = true;
      try {
        await api('admin/request', { id: request.id, status: select.value });
        await refresh();
        feedback(notice, 'Статус заявки обновлён.');
      } catch (error) {
        showError(error);
      } finally {
        change.disabled = false;
      }
    });
    row.append(select, change);
    card.append(row);
    list.append(card);
  }
  if (!selected.length) list.append(element('p', 'empty', 'Заявок с этими параметрами пока нет.'));
}
try {
  await refresh();
  feedback(notice, '');
} catch (error) {
  if (error.status === 401) {
    feedback(notice, '');
    setLogin(true);
  } else {
    showError(error);
    setLogin(true);
  }
}

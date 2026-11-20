import { $, element, api, button, feedback, submit, priceLabel, monthLabel, dateLabel } from './common.js';

const icons = {
  heart: '<path d="M40 63 17 42C3 27 22 9 40 26c18-17 37 1 23 16Z"/><path d="M40 54 22 37c-8-8 3-18 11-12l7 6 7-6c8-6 19 4 11 12Z"/>',
  star: '<path d="M40 8c0 21 11 32 32 32-21 0-32 11-32 32 0-21-11-32-32-32C29 40 40 29 40 8Z"/><path d="M40 24c0 11 5 16 16 16-11 0-16 5-16 16 0-11-5-16-16-16 11 0 16-5 16-16Z"/>',
  music: '<path d="M33 54V24l26-6v29M33 54c0 6-16 10-16 2 0-6 16-10 16-2Zm26-7c0 6-16 10-16 2 0-6 16-10 16-2ZM33 33l26-6"/>',
  eye: '<path d="M8 40s13-16 32-16 32 16 32 16-13 16-32 16S8 40 8 40Z"/><circle cx="40" cy="40" r="10"/><path d="M40 13v6m0 42v6M16 20l5 5m38 30 5 5m0-40-5 5M21 55l-5 5"/>',
  mic: '<rect x="32" y="15" width="16" height="34" rx="8"/><path d="M25 37v5a15 15 0 0 0 30 0v-5M40 57v9m-10 0h20m-18-35h5m6 0h5"/>',
  suit: '<path d="M40 14c8 13 24 19 24 31 0 9-13 14-22 5 0 7 5 11 10 15H28c5-4 10-8 10-15-9 9-22 4-22-5 0-12 16-18 24-31Z"/>',
};

let events = [];
let kinds = {};
let months = [];
let monthIndex = 0;
let category = 'all';
let visible = 6;
let selectedEvent;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const entrances = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const { isIntersecting, target } of entries) {
    if (!isIntersecting) continue;
    if (!reducedMotion.matches) target.classList.add('entered');
    entrances.unobserve(target);
  }
}, { rootMargin: '0px 0px -20px 0px' }) : null;

for (const target of document.querySelectorAll('[data-enter]')) entrances?.observe(target);

function poster(event) {
  const node = element('div', 'poster ' + event.category);
  const label = kinds[event.category][0];
  const icon = icons[kinds[event.category][1]];
  node.innerHTML = '<span class="poster-frame"></span><span class="poster-cross pc-a">+</span><span class="poster-cross pc-b">+</span><svg viewBox="0 0 80 80" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' + icon + '</svg>';
  node.append(element('span', 'poster-label', label));
  node.setAttribute('aria-hidden', 'true');
  return node;
}
function card(event, mixed) {
  const node = element('article', 'event-card');
  node.dataset.enter = 'card';
  const content = element('div', 'event-content');
  const date = element('time', 'event-time', dateLabel(event.day) + ' · ' + event.time);
  date.dateTime = event.day + 'T' + event.time + ':00+03:00';
  const meta = element('div', 'event-meta');
  meta.append(date, element('span', 'room', event.room + (mixed && event.demo ? ' · Демо' : '')));
  const bottom = element('div', 'event-bottom');
  const open = button('Записаться ↗', 'button light-outline', () => openBooking(event));
  open.setAttribute('aria-label', 'Записаться на событие «' + event.title + '»');
  bottom.append(element('strong', 'price', priceLabel(event.price)), open);
  content.append(meta, element('h3', '', event.title), element('p', 'event-description', event.description), bottom);
  node.append(poster(event), content);
  return node;
}
function renderSchedule(appendFrom = 0) {
  const monthEvents = events.filter(event => event.day.startsWith(months[monthIndex]));
  const selection = monthEvents.filter(event => category === 'all' || category === event.category);
  if (!appendFrom) $('#categories').replaceChildren(...[['all', 'Все'], ...Object.entries(kinds).filter(([key]) => monthEvents.some(event => event.category === key)).map(([key, value]) => [key, value[0]])].map(([key, label]) => {
    const chip = button(label, 'chip', () => {
      category = key;
      visible = 6;
      renderSchedule();
      $('#categories').querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
    });
    chip.setAttribute('aria-pressed', String(key === category));
    return chip;
  }));
  const shown = selection.slice(0, visible);
  const demo = selection.every(event => event.demo);
  $('#demo-notice').hidden = !shown.some(event => event.demo);
  $('#demo-notice').lastChild.textContent = demo ? ' Демо-афиша. Даты и цены указаны для примера.' : ' Часть афиши демонстрационная.';
  const grid = $('#events');
  const cards = shown.slice(appendFrom).map(event => card(event, !demo));
  if (!appendFrom) {
    for (const previous of grid.children) entrances?.unobserve(previous);
    grid.replaceChildren(...(cards.length ? cards : [element('p', 'empty', 'Пока событий в афише нет. Загляни чуть позже.')]));
  } else {
    grid.append(...cards);
  }
  for (const item of cards) entrances?.observe(item);
  $('#more').hidden = visible >= selection.length;
}

const monthArrows = [$('#month-prev'), $('#month-next')];
function renderMonth(direction) {
  const month = months[monthIndex];
  if (!month) return;
  const [label, year] = monthLabel(month).split(' ');
  const title = element('span', 'month-title');
  title.append(element('span', 'month-name', label), document.createTextNode(' '), element('span', 'month-year', year));
  if (direction) title.classList.add(direction > 0 ? 'month-forward' : 'month-backward');
  $('#month-caption').replaceChildren(title);
  monthArrows.forEach((arrow, index) => {
    arrow.hidden = months.length < 2;
    arrow.setAttribute('aria-disabled', String(index === 0 ? monthIndex === 0 : monthIndex === months.length - 1));
  });
}
function changeMonth(direction) {
  const next = monthIndex + direction;
  if (!months[next]) return;
  monthIndex = next;
  category = 'all';
  visible = 6;
  renderMonth(direction);
  renderSchedule();
}
monthArrows[0].addEventListener('click', () => changeMonth(-1));
monthArrows[1].addEventListener('click', () => changeMonth(1));

$('#more').addEventListener('click', () => {
  const previouslyVisible = visible;
  visible += 6;
  renderSchedule(previouslyVisible);
  $('#events').children[previouslyVisible]?.querySelector('button')?.focus();
});
const dialog = $('#booking');
const bookingForm = $('#booking-form');
function openBooking(event) {
  selectedEvent = event;
  bookingForm.reset();
  bookingForm.hidden = false;
  $('#booking-success').hidden = true;
  feedback(bookingForm.querySelector('.form-status'), '');
  $('#booking-title').textContent = event.title;
  $('#booking-details').textContent = dateLabel(event.day) + ' · ' + event.time + ' · ' + priceLabel(event.price) + ' · ' + event.room + (event.demo ? ' · демо' : '');
  dialog.showModal();
}
bookingForm.addEventListener('submit', event => {
  event.preventDefault();
  const eventId = selectedEvent.id;
  submit(bookingForm, async values => {
    await api('book', { ...values, eventId, guests: Number(values.guests) });
    if (selectedEvent.id !== eventId) return;
    bookingForm.hidden = true;
    $('#booking-success').hidden = false;
    $('#booking-success button').focus();
  });
});
$('#partner-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  submit(form, async (values, status) => {
    await api('partner', values);
    form.reset();
    feedback(status, 'Предложение отправлено. Свяжемся с тобой, чтобы обсудить детали.');
  });
});

function renderPoll(poll, note = '') {
  const ballot = $('#ballot');
  if (!poll) {
    ballot.replaceChildren(element('p', '', 'Новое голосование скоро появится.'));
    return;
  }
  const total = poll.choices.reduce((sum, choice) => sum + (choice.count || 0), 0);
  const heading = element('div', 'ballot-heading');
  heading.append(element('h3', '', monthLabel(poll.month)), element('span', 'poll-state', poll.demo ? (poll.open ? 'Демо-опрос' : 'Демо завершено') : (poll.open ? 'Голосование открыто' : 'Голосование завершено')));
  const form = element('form', 'poll-form');
  const group = element('fieldset', 'poll-choices');
  group.disabled = !poll.open;
  group.append(element('legend', 'sr-only', 'Форматы событий'));
  for (const choice of poll.choices) {
    const row = element('label', 'vote-row');
    const input = element('input');
    input.type = 'radio';
    input.name = 'choiceId';
    input.value = choice.id;
    input.required = true;
    input.checked = poll.selected === choice.id;
    row.append(input, element('span', '', choice.label));
    if (choice.count !== null) {
      const percent = total ? Math.round(choice.count * 100 / total) : 0;
      const bar = element('progress', 'vote-progress');
      bar.max = 100;
      bar.value = percent;
      bar.setAttribute('aria-label', choice.label + ', доля голосов');
      row.append(element('strong', 'percent', percent + '%'), bar);
    }
    group.append(row);
  }
  form.append(group);
  if (poll.open) {
    const send = element('button', 'button gold', poll.selected ? 'Изменить голос ↗' : 'Проголосовать ↗');
    send.type = 'submit';
    form.append(send);
  }
  const status = element('p', 'form-status', note || (poll.selected ? 'Твой голос учтён. Его можно изменить, пока опрос открыт.' : (poll.open ? 'Результаты откроются после твоего голоса.' : 'Всего голосов — ' + total)));
  status.setAttribute('role', 'status');
  form.append(status);
  form.addEventListener('submit', event => {
    event.preventDefault();
    submit(form, async values => {
      try {
        renderPoll(await api('vote', { pollId: poll.id, choiceId: Number(values.choiceId) }), 'Твой голос учтён. Его можно изменить до закрытия опроса.');
        const updated = ballot.querySelector('.form-status');
        updated.tabIndex = -1;
        updated.focus({ preventScroll: true });
      } catch (error) {
        if (error.status !== 409) throw error;
        renderPoll((await api('site')).poll, 'Предыдущее голосование завершилось.');
      }
    });
  });
  ballot.replaceChildren(heading, form);
}

try {
  const data = await api('site');
  ({ events, kinds } = data);
  months = [...new Set(events.map(event => event.day.slice(0, 7)))];
  renderMonth();
  $('#filters').hidden = months.length === 0;
  if (data.address) $('#address').textContent = data.address;
  renderSchedule();
  renderPoll(data.poll);
} catch {
  $('#events').replaceChildren(element('p', 'empty', 'Афиша не загрузилась. Обнови страницу чуть позже.'));
  $('#ballot').replaceChildren(element('p', '', 'Голосование не загрузилось. Попробуй чуть позже.'));
}

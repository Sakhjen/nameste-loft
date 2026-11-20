export const $ = selector => document.querySelector(selector);
export function element(tag, style, content) {
  const node = document.createElement(tag);
  if (style) node.className = style;
  if (content !== undefined) node.textContent = content;
  return node;
}
export async function api(path, data) {
  const response = await fetch('/api/' + path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
  return result;
}
export function button(label, style, action) {
  const node = element('button', style, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
export function feedback(node, text, error = false) {
  node.textContent = text;
  node.classList.toggle('error', error);
}
export async function submit(form, run) {
  const control = form.querySelector('button[type="submit"]');
  const status = form.querySelector('.form-status');
  control.disabled = true;
  feedback(status, 'Отправляем…');
  try {
    await run(Object.fromEntries(new FormData(form)), status);
  } catch (error) {
    feedback(status, error.status ? error.message : 'Нет связи с сервером. Попробуй ещё раз.', true);
  } finally {
    control.disabled = false;
  }
}
const money = new Intl.NumberFormat('ru', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
export const priceLabel = amount => amount ? money.format(amount) : 'Бесплатно';
const monthFormatter = new Intl.DateTimeFormat('ru', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayFormatter = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', weekday: 'short', timeZone: 'UTC' });
export const monthLabel = value => monthFormatter.format(new Date(value + '-01')).replace(/ г\.$/, '');
export const dateLabel = value => dayFormatter.format(new Date(value));

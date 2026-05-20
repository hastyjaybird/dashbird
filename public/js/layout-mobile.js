const MOBILE_MQ = '(max-width: 900px)';

/**
 * On mobile, park the sky sidebar under Tool Library; on desktop, restore it beside main.
 */
export function initSkySidebarPlacement() {
  const sky = document.querySelector('.sky-sidebar');
  const mobileHost = document.getElementById('sky-sidebar-mobile-host');
  const layoutBody = document.querySelector('.layout-body');
  const healthAside = document.getElementById('mount-health-sidebar');
  if (!sky || !mobileHost || !layoutBody) return;

  const mq = window.matchMedia(MOBILE_MQ);

  function place() {
    if (mq.matches) {
      mobileHost.hidden = false;
      mobileHost.setAttribute('aria-hidden', 'false');
      mobileHost.append(sky);
      sky.classList.add('sky-sidebar--in-main');
    } else {
      sky.classList.remove('sky-sidebar--in-main');
      mobileHost.hidden = true;
      mobileHost.setAttribute('aria-hidden', 'true');
      if (healthAside && healthAside.parentElement === layoutBody) {
        layoutBody.insertBefore(sky, healthAside);
      } else {
        layoutBody.append(sky);
      }
    }
  }

  place();
  mq.addEventListener('change', place);
}

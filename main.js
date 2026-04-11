(function(){
  /* Shared constants */
  const SQ_URL='https://app.squareup.com/appointments/book/98fw77ulsmdgb9/LRR0VEQVKE8BT/start';
  const SQ_SERVICES={
    massage:'https://book.squareup.com/appointments/98fw77ulsmdgb9/location/LRR0VEQVKE8BT/services/HO57BZIYWVBXHKKXZHL3UVAE',
    manicure:'https://book.squareup.com/appointments/98fw77ulsmdgb9/location/LRR0VEQVKE8BT/services/2S2PCROBXNSFZZQKO2JDL2OW'
  };

  /* iOS-safe body scroll lock */
  let _scrollY=0;
  function lockBody(){_scrollY=window.scrollY;document.body.style.position='fixed';document.body.style.top=`-${_scrollY}px`;document.body.style.width='100%';}
  function unlockBody(){document.body.style.position='';document.body.style.top='';document.body.style.width='';window.scrollTo(0,_scrollY);}

  function buildBookingUrl(service){
    const currentPage = (window.location.pathname.split('/').pop() || 'index.html').replace(/^\//,'');
    const params = new URLSearchParams();
    const inferredService = service || (currentPage.includes('massage') ? 'massage' : currentPage.includes('manicure') ? 'manicure' : '');
    if(inferredService) params.set('service', inferredService);
    if(currentPage !== 'booking.html') params.set('return', currentPage);
    return `booking.html${params.toString() ? `?${params.toString()}` : ''}`;
  }

  /* Header shadow */
  function initHeaderShadow(){window.addEventListener('scroll',()=>{const h=document.getElementById('site-header'); if(h) h.classList.toggle('scrolled',window.scrollY>40);},{passive:true});}

  /* Hamburger menu */
  function initHamburger(){
    const ham=document.getElementById('hamburger');
    const nav=document.getElementById('navMenu');
    if(!ham||!nav) return;

    function openMenu(){
      ham.classList.add('active');
      ham.setAttribute('aria-expanded','true');
      nav.classList.add('active');
      document.body.classList.add('no-scroll');
    }

    function closeMenu(){
      ham.classList.remove('active');
      ham.setAttribute('aria-expanded','false');
      nav.classList.remove('active');
      document.body.classList.remove('no-scroll');
    }

    window.openMenu = openMenu;
    window.closeMenu = closeMenu;

    ham.addEventListener('click',()=>nav.classList.contains('active') ? closeMenu() : openMenu());
    document.querySelectorAll('.nav-link').forEach(l=>l.addEventListener('click',closeMenu));
    document.addEventListener('click',e=>{
      if(nav.classList.contains('active') && !ham.contains(e.target) && !nav.contains(e.target)) closeMenu();
    });
  }

  /* Swiper init for present sliders */
  function initSwipers(){
    if(typeof Swiper === 'undefined') return;

    const baseOptions = {
      slidesPerView: 1,
      spaceBetween: 20,
      loop: true,
      speed: 700,
      autoplay: { delay: 7500, disableOnInteraction: false },
      pagination: { el: '.swiper-pagination', clickable: true },
      observer: true,
      observeParents: true,
      breakpoints: {
        640: { slidesPerView: 2 },
        1024: { slidesPerView: 3, spaceBetween: 24 }
      }
    };

    if(document.querySelector('.mySwiper')) {
      new Swiper('.mySwiper', baseOptions);
    }

    if(document.querySelector('.nailSwiper')) {
      new Swiper('.nailSwiper', {
        ...baseOptions,
        breakpoints: {
          640: { slidesPerView: 2 },
          1024: { slidesPerView: 3 }
        }
      });
    }

    if(document.querySelector('.massageSwiper')) {
      new Swiper('.massageSwiper', {
        ...baseOptions,
        breakpoints: {
          640: { slidesPerView: 2 },
          1024: { slidesPerView: 3 }
        }
      });
    }
  }

  /* Booking routing */
  function initBookingModal(){
    function openBooking(service){
      window.location.href = buildBookingUrl(service);
    }
    function closeBooking(){}

    window.openBooking = openBooking;
    window.closeBooking = closeBooking;
  }

  /* goToBooking for service pages */
  function goToBooking(service){
    window.location.href = buildBookingUrl(service);
  }
  window.goToBooking = goToBooking;

  /* FAQ accordion */
  function initFAQ(){
    document.querySelectorAll('.faq-item').forEach(item=>{
      const btn=item.querySelector('.faq-q'); if(!btn) return;
      btn.addEventListener('click',()=>{
        const isOpen=item.classList.contains('open');
        document.querySelectorAll('.faq-item').forEach(el=>{
          el.classList.remove('open');
          const q=el.querySelector('.faq-q'); if(q) q.setAttribute('aria-expanded','false');
          const b=el.querySelector('.faq-body'); if(b) b.style.maxHeight = '0px';
        });
        if(!isOpen){
          item.classList.add('open');
          btn.setAttribute('aria-expanded','true');
          // Force reflow and set max-height
          const b=item.querySelector('.faq-body');
          if(b){
            b.style.maxHeight = '0px';
            setTimeout(() => { b.style.maxHeight = b.scrollHeight + 'px'; }, 10);
          }
        }
      });
    });
  }

  /* Massage availability / urgency */
  function initAvailabilityBanner(){
    const banner=document.getElementById('availability-banner');
    const headline=document.getElementById('availability-headline');
    const sub=document.getElementById('availability-sub');
    if(!banner || !headline || !sub) return;

    const now=new Date();
    const day=now.getDay();
    const hour=now.getHours();
    const dayNames=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const tomorrowName=dayNames[(day + 1) % 7];
    let messages=[];

    if(day === 0){
      messages = [
        { headline: `Tomorrow: Morning and afternoon openings`, sub: `${tomorrowName} booking is open now · Instant confirmation online` },
        { headline: `This week fills quickly`, sub: `Reserve your preferred time before evening spots are gone` }
      ];
    } else if(hour < 11){
      messages = [
        { headline: `Today: Morning and afternoon availability`, sub: `Same-day massage may still be available · Book in 60 seconds` },
        { headline: `Tomorrow: Prime time opens now`, sub: `Secure a time that fits your schedule before it fills` }
      ];
    } else if(hour < 15){
      messages = [
        { headline: `Today: Limited afternoon availability`, sub: `A good window for same-day neck, back, or shoulder relief` },
        { headline: `Tomorrow: More flexible times available`, sub: `Reserve now for the best appointment options` }
      ];
    } else if(hour < 19){
      messages = [
        { headline: `Today: Final openings this evening`, sub: `If you want same-day relief, now is the time to book` },
        { headline: `Tomorrow: Morning slots go first`, sub: `Book ahead to lock in a convenient time` }
      ];
    } else {
      messages = [
        { headline: `Tomorrow: Early availability is open`, sub: `Tonight is the best time to reserve before the day fills up` },
        { headline: `This week: Limited evening spots`, sub: `Instant confirmation · Free parking · Easy online booking` }
      ];
    }

    let index=0;
    function renderMessage(){
      headline.textContent = messages[index].headline;
      sub.textContent = messages[index].sub;
    }

    renderMessage();
    if(messages.length > 1){
      setInterval(()=>{
        index = (index + 1) % messages.length;
        renderMessage();
      }, 5000);
    }
  }

  /* Booking page service pills (if present) */
  function initBookingPills(){
    const pills = document.querySelectorAll('.svc-pill');
    const frame = document.getElementById('sq-frame') || document.getElementById('sq-iframe');
    const loader = document.getElementById('sq-loading');
    const params = new URLSearchParams(window.location.search);
    const service = params.get('service');
    const returnUrl = params.get('return') || 'index.html';
    const safeReturn = returnUrl.includes('://') ? 'index.html' : returnUrl;

    const backButton = document.getElementById('booking-back');
    const homeLink = document.getElementById('booking-home-link');
    if(backButton) backButton.addEventListener('click', ()=>{ window.location.href = safeReturn; });
    if(homeLink) homeLink.setAttribute('href', safeReturn);

    if(!pills || pills.length===0 || !frame) return;

    pills.forEach(pill=>{
      pill.addEventListener('click', ()=>{
        pills.forEach(p=>p.classList.remove('active'));
        pill.classList.add('active');
        if(loader) loader.classList.remove('hidden');
        frame.src = pill.dataset.url;
      });
    });

    frame.addEventListener('load', ()=>{ if(loader) loader.classList.add('hidden'); });

    if(service){
      const normalizedService = service.toLowerCase();
      const exact = [...pills].find(p => (p.dataset.service || '').toLowerCase() === normalizedService);
      const fallback = [...pills].find(p => p.textContent.toLowerCase().includes(normalizedService.replace(/-/g,' ')));
      const match = exact || fallback;
      if(match) match.click();
    }
  }

  /* Replace inline booking handlers with data attributes */
  function initActionButtons(){
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-book-action]');
      if(!trigger) return;

      const action = (trigger.dataset.bookAction || 'open').toLowerCase();
      const service = trigger.dataset.bookService || '';

      if(trigger.dataset.closeMenu === 'true' && typeof window.closeMenu === 'function'){
        window.closeMenu();
      }

      if(action === 'go'){
        goToBooking(service);
        return;
      }

      if(typeof window.openBooking === 'function'){
        window.openBooking(service);
      } else {
        window.location.href = buildBookingUrl(service);
      }
    });
  }

  /* Replace inline image onerror handlers */
  function initImageFallbacks(){
    document.querySelectorAll('img[data-fallback-src]').forEach((img) => {
      img.addEventListener('error', () => {
        if(img.dataset.fallbackApplied === 'true') return;
        img.dataset.fallbackApplied = 'true';
        img.src = img.dataset.fallbackSrc;
      });
    });

    document.querySelectorAll('img[data-hide-on-error="true"]').forEach((img) => {
      img.addEventListener('error', () => {
        img.style.display = 'none';
      });
    });
  }

  /* Shared rotating video overlay copy */
  function initVideoRotators(){
    const rotators = [
      {
        kickerId: 'massage-video-kicker',
        headlineId: 'massage-video-headline',
        slides: [
          {
            kicker: 'Inside a real session',
            headline: 'Targeted work.<br><em>Real relief.</em>'
          },
          {
            kicker: 'Results-focused care',
            headline: 'Less tension.<br><em>Better movement.</em>'
          },
          {
            kicker: 'Professional therapeutic massage',
            headline: 'Restore mobility.<br><em>Feel the difference.</em>'
          }
        ]
      },
      {
        kickerId: 'manicure-video-kicker',
        headlineId: 'manicure-video-headline',
        slides: [
          {
            kicker: 'Inside a real appointment',
            headline: 'Clean work. Zero lifting.<br><em>Results that last.</em>'
          },
          {
            kicker: 'Precision Russian technique',
            headline: 'Clean cuticles.<br><em>4-week retention.</em>'
          },
          {
            kicker: 'No shortcuts',
            headline: 'Structured application.<br><em>Beautiful for weeks.</em>'
          }
        ]
      }
    ];

    rotators.forEach(({ kickerId, headlineId, slides }) => {
      const kicker = document.getElementById(kickerId);
      const headline = document.getElementById(headlineId);
      const section = kicker ? kicker.closest('.video-vibe-sec') : null;
      const video = section ? section.querySelector('.bg-video') : null;

      if(!section || !kicker || !headline || !video) return;

      let currentIndex = 0;
      let intervalId = null;

      [kicker, headline].forEach((el) => {
        el.style.transition = 'opacity .35s ease, transform .35s ease';
        el.style.willChange = 'opacity, transform';
      });

      function renderSlide(index){
        kicker.textContent = slides[index].kicker;
        headline.innerHTML = slides[index].headline;
      }

      function swapSlide(nextIndex){
        [kicker, headline].forEach((el) => {
          el.style.opacity = '0';
          el.style.transform = 'translateY(8px)';
        });

        window.setTimeout(() => {
          currentIndex = nextIndex;
          renderSlide(currentIndex);
          [kicker, headline].forEach((el) => {
            el.style.opacity = '1';
            el.style.transform = 'translateY(0)';
          });
        }, 220);
      }

      function startRotation(){
        if(intervalId) return;
        intervalId = window.setInterval(() => {
          swapSlide((currentIndex + 1) % slides.length);
        }, 4500);
      }

      function stopRotation(){
        if(!intervalId) return;
        window.clearInterval(intervalId);
        intervalId = null;
      }

      renderSlide(currentIndex);

      try {
        video.playbackRate = 0.95;
      } catch (_) {}

      if('IntersectionObserver' in window){
        const observer = new IntersectionObserver((entries) => {
          const isVisible = entries.some((entry) => entry.isIntersecting);
          if(isVisible){
            video.play().catch(() => {});
            startRotation();
          } else {
            video.pause();
            stopRotation();
          }
        }, { threshold: 0.35 });

        observer.observe(section);
      } else {
        video.play().catch(() => {});
        startRotation();
      }
    });
  }

  /* Initialize on DOM ready */
  document.addEventListener('DOMContentLoaded', ()=>{
    initHeaderShadow();
    initHamburger();
    initSwipers();
    initBookingModal();
    initActionButtons();
    initImageFallbacks();
    initFAQ();
    initAvailabilityBanner();
    initBookingPills();
    initVideoRotators();
  });
})();


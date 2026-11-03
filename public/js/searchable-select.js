// Progressive-enhancement searchable dropdown.
// The native <select> stays in the DOM as the single source of truth for
// value/validation/submit; this only adds a searchable trigger+panel UI on
// top of it. Usage: SearchableSelect.enhance(selectEl) -> instance.
(function () {
  function closeAllExcept(except) {
    document.querySelectorAll('.ss-panel.open').forEach(function (panel) {
      if (panel !== except) panel.classList.remove('open');
    });
  }

  function Instance(select, opts) {
    this.select = select;
    this.opts = opts || {};
    this.highlightedIndex = -1;
    this._build();
    this._bind();
    this.sync();
  }

  Instance.prototype._build = function () {
    var select = this.select;

    select.classList.add('ss-visually-hidden');

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'form-control ss-trigger';
    if (select.disabled) trigger.disabled = true;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    var panel = document.createElement('div');
    panel.className = 'ss-panel';

    var search = document.createElement('input');
    search.type = 'text';
    search.className = 'ss-search';
    search.setAttribute('placeholder', 'بحث...');
    search.setAttribute('autocomplete', 'off');

    var list = document.createElement('div');
    list.className = 'ss-list';
    list.setAttribute('role', 'listbox');

    panel.appendChild(search);
    panel.appendChild(list);

    select.insertAdjacentElement('afterend', trigger);
    document.body.appendChild(panel);

    this.trigger = trigger;
    this.panel = panel;
    this.search = search;
    this.list = list;
  };

  Instance.prototype._optionEls = function () {
    return Array.prototype.filter.call(this.select.options, function (o) {
      return o.value !== '';
    });
  };

  Instance.prototype._placeholderText = function () {
    var first = this.select.options[0];
    return first && first.value === '' ? first.textContent : '';
  };

  Instance.prototype._renderList = function (filterText) {
    var list = this.list;
    list.innerHTML = '';
    this.highlightedIndex = -1;

    var q = (filterText || '').trim().toLowerCase();
    var options = this._optionEls();
    var matches = options.filter(function (o) {
      return o.textContent.toLowerCase().indexOf(q) !== -1;
    });

    if (!matches.length) {
      var empty = document.createElement('div');
      empty.className = 'ss-empty';
      empty.textContent = 'لا توجد نتائج';
      list.appendChild(empty);
      return;
    }

    var currentValue = this.select.value;
    var self = this;
    matches.forEach(function (opt, idx) {
      var row = document.createElement('div');
      row.className = 'ss-option';
      row.setAttribute('role', 'option');
      row.dataset.value = opt.value;
      row.textContent = opt.textContent;
      if (opt.value === currentValue) {
        row.classList.add('ss-option--active');
        self.highlightedIndex = idx;
      }
      row.addEventListener('mousedown', function (e) {
        e.preventDefault();
        self._select(opt.value, opt.textContent);
      });
      list.appendChild(row);
    });
  };

  Instance.prototype._highlight = function (idx) {
    var rows = this.list.querySelectorAll('.ss-option');
    if (!rows.length) return;
    if (idx < 0) idx = 0;
    if (idx > rows.length - 1) idx = rows.length - 1;
    rows.forEach(function (r) { r.classList.remove('ss-option--active'); });
    var row = rows[idx];
    if (row) {
      row.classList.add('ss-option--active');
      row.scrollIntoView({ block: 'nearest' });
    }
    this.highlightedIndex = idx;
  };

  Instance.prototype._select = function (value, text) {
    this.select.value = value;
    this.trigger.textContent = text;
    this.close();
    this.select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  Instance.prototype._position = function () {
    var rect = this.trigger.getBoundingClientRect();
    var panel = this.panel;
    panel.style.width = rect.width + 'px';
    panel.style.left = rect.left + 'px';

    var panelHeight = panel.offsetHeight || 260;
    var spaceBelow = window.innerHeight - rect.bottom;
    var flipUp = spaceBelow < panelHeight && rect.top > spaceBelow;

    if (flipUp) {
      panel.style.top = '';
      panel.style.bottom = (window.innerHeight - rect.top) + 'px';
    } else {
      panel.style.bottom = '';
      panel.style.top = rect.bottom + 'px';
    }
  };

  Instance.prototype.open = function () {
    if (this.select.disabled) return;
    closeAllExcept(this.panel);
    this.panel.classList.add('open');
    this.trigger.setAttribute('aria-expanded', 'true');
    this.search.value = '';
    this._renderList('');
    this._position();
    var activeRow = this.list.querySelector('.ss-option--active');
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
    this.search.focus();

    this._onScroll = this._position.bind(this);
    this._onResize = this._position.bind(this);
    window.addEventListener('scroll', this._onScroll, true);
    window.addEventListener('resize', this._onResize);
  };

  Instance.prototype.close = function () {
    this.panel.classList.remove('open');
    this.trigger.setAttribute('aria-expanded', 'false');
    if (this._onScroll) window.removeEventListener('scroll', this._onScroll, true);
    if (this._onResize) window.removeEventListener('resize', this._onResize);
  };

  Instance.prototype.isOpen = function () {
    return this.panel.classList.contains('open');
  };

  Instance.prototype.sync = function () {
    var selected = this.select.options[this.select.selectedIndex];
    this.trigger.textContent = selected ? selected.textContent : this._placeholderText();
  };

  Instance.prototype.refresh = function () {
    this.sync();
    if (this.isOpen()) this._renderList(this.search.value);
  };

  Instance.prototype._bind = function () {
    var self = this;

    this.trigger.addEventListener('click', function () {
      if (self.isOpen()) self.close();
      else self.open();
    });

    this.search.addEventListener('input', function () {
      self._renderList(self.search.value);
    });

    this.panel.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        self._highlight(self.highlightedIndex + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        self._highlight(self.highlightedIndex - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        var row = self.list.querySelectorAll('.ss-option')[self.highlightedIndex];
        if (row) self._select(row.dataset.value, row.textContent);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        self.close();
      } else if (e.key === 'Tab') {
        self.close();
      }
    });

    this._onDocMouseDown = function (e) {
      if (!self.isOpen()) return;
      if (self.panel.contains(e.target) || self.trigger.contains(e.target)) return;
      self.close();
    };
    document.addEventListener('mousedown', this._onDocMouseDown);
  };

  Instance.prototype.destroy = function () {
    document.removeEventListener('mousedown', this._onDocMouseDown);
    if (this._onScroll) window.removeEventListener('scroll', this._onScroll, true);
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this.trigger.parentNode) this.trigger.parentNode.removeChild(this.trigger);
    if (this.panel.parentNode) this.panel.parentNode.removeChild(this.panel);
    this.select.classList.remove('ss-visually-hidden');
  };

  window.SearchableSelect = {
    enhance: function (select, options) {
      return new Instance(select, options);
    }
  };
})();

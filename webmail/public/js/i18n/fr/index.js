// All French text, merged. One file per source file so changes stay separate.
import common from './common.js';
import indexhtml from './index-html.js';
import adminhtml from './admin-html.js';
import main from './main.js';
import api from './api.js';
import util from './util.js';
import mail from './mail.js';
import list from './list.js';
import reader from './reader.js';
import sidebar from './sidebar.js';
import labels from './labels.js';
import safeHtml from './safeHtml.js';
import compose from './compose.js';
import settings from './settings.js';
import admin from './admin.js';

export default Object.freeze(Object.assign({}, common, indexhtml, adminhtml, main, api, util, mail, list, reader, sidebar, labels, safeHtml, compose, settings, admin));

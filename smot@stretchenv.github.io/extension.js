import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Indicator} from './ui/indicator.js';

export default class SmotExtension extends Extension {
    enable() {
        if (this._indicator)
            return;
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea('smot', this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}

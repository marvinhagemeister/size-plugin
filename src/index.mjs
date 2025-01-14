/**
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

import path from 'path';
import promisify from 'util.promisify';
import globPromise from 'glob';
import minimatch from 'minimatch';
import gzipSize from 'gzip-size';
import chalk from 'chalk';
import prettyBytes from 'pretty-bytes';
import escapeRegExp from 'escape-string-regexp';
import { toMap, dedupe, toFileMap } from './util.mjs';
import { publishSizes, publishDiff } from './publish-size.mjs';
import fs from 'fs-extra';

const glob = promisify(globPromise);
const NAME = 'SizePlugin';

/**
 * `new SizePlugin(options)`
 * @param {Object} options
 * @param {string} [options.pattern] minimatch pattern of files to track
 * @param {string} [options.exclude] minimatch pattern of files NOT to track
 * @param {string} [options.filename] file name to save filesizes to disk
 * @param {boolean} [options.publish] option to publish filesizes to size-plugin-store
 * @param {boolean} [options.writeFile] option to save filesizes to disk
 * @param {function} [options.stripHash] custom function to remove/normalize hashed filenames for comparison
 * @param {(item:Item)=>string?} [options.decorateItem] custom function to decorate items
 * @param {(data:Data)=>string?} [options.decorateAfter] custom function to decorate all output
 * @public
 */
export default class SizePlugin {
	constructor(options) {
		this.options = options || {};
		this.pattern = this.options.pattern || '**/*.{mjs,js,css,html}';
		this.exclude = this.options.exclude;
		this.options.filename = this.options.filename || 'size-plugin.json';
		this.options.writeFile = this.options.writeFile !== false;
		this.filename = path.join(process.cwd(), this.options.filename);
	}

	reverseTemplate(filename, template) {
		// @todo - find a way to actually obtain values here.
		if (typeof template === 'function') {
			template = template({
				chunk: {
					name: 'main'
				}
			});
		}
		const hashLength = this.output.hashDigestLength;
		const replace = [];
		let count = 0;
		function replacer() {
			let out = '';
			for (let i = 1; i < arguments.length - 2; i++) {
				// eslint-disable-next-line prefer-spread,prefer-rest-params
				let value = arguments[i];
				if (replace[i - 1]) value = value.replace(/./g, '*');
				out += value;
			}
			return out;
		}
		const reg = template.replace(
			/(^|.+?)(?:\[([a-z]+)(?::(\d))?\]|$)/g,
			(s, before, type, size) => {
				let out = '';
				if (before) {
					out += `(${escapeRegExp(before)})`;
					replace[count++] = false;
				}
				if (type === 'hash' || type === 'contenthash' || type === 'chunkhash') {
					const len = Math.round(size) || hashLength;
					out += `([0-9a-zA-Z]{${len}})`;
					replace[count++] = true;
				}
				else if (type) {
					out += '(.*?)';
					replace[count++] = false;
				}
				return out;
			}
		);
		const matcher = new RegExp(`^${reg}$`);
		return matcher.test(filename) && filename.replace(matcher, replacer);
	}

	stripHash(filename) {
		return (
			(this.options.stripHash && this.options.stripHash(filename)) ||
			this.reverseTemplate(filename, this.output.filename) ||
			this.reverseTemplate(filename, this.output.chunkFilename) ||
			filename
		);
	}
	async readFromDisk(filename) {
		try {
			await fs.ensureFile(filename);
			const oldStats = await fs.readJSON(filename);
			return oldStats.sort((a, b) => b.timestamp - a.timestamp);
		}
		catch (err) {
			return [];
		}
	}
	async writeToDisk(filename, stats) {
		if (
			this.mode === 'production' &&
			stats.files.some(file => file.diff !== 0)
		) {
			const data = await this.readFromDisk(filename);
			data.unshift(stats);
			if (this.options.writeFile) {
				await fs.ensureFile(filename);
				await fs.writeJSON(filename, data);
			}
			this.options.publish && (await publishSizes(data, this.options.filename));
		}
	}
	async save(files) {
		const stats = {
			timestamp: Date.now(),
			files: files.map(file => ({
				filename: file.name,
				previous: file.sizeBefore,
				size: file.size,
				diff: file.size - file.sizeBefore
			}))
		};
		this.options.publish && (await publishDiff(stats, this.options.filename));
		this.options.save && (await this.options.save(stats));
		await this.writeToDisk(this.filename, stats);
	}
	async load(outputPath) {
		const data = await this.readFromDisk(this.filename);
		if (data.length) {
			const [{ files }] = data;
			return toFileMap(files);
		}
		return this.getSizes(outputPath);
	}
	async apply(compiler) {
		const outputPath = compiler.options.output.path;
		this.output = compiler.options.output;
		this.sizes = this.load(outputPath);
		this.mode = compiler.options.mode;

		const afterEmit = (compilation, callback) => {
			this.outputSizes(compilation.assets)
				.then(output => {
					if (output) {
						process.nextTick(() => {
							console.log('\n' + output);
						});
					}
				})
				.catch(console.error)
				.then(callback);
		};

		// for webpack version > 4
		if (compiler.hooks && compiler.hooks.emit) {
			compiler.hooks.emit.tapAsync(NAME, afterEmit);
		}
		else {
			// for webpack version < 3
			compiler.plugin('after-emit', afterEmit);
		}
	}

	async outputSizes(assets) {
		// map of filenames to their previous size
		// Fix #7 - fast-async doesn't allow non-promise values.
		const sizesBefore = await Promise.resolve(this.sizes);
		const isMatched = minimatch.filter(this.pattern);
		const isExcluded = this.exclude
			? minimatch.filter(this.exclude)
			: () => false;
		const assetNames = Object.keys(assets).filter(
			file => isMatched(file) && !isExcluded(file)
		);
		const sizes = await Promise.all(
			assetNames.map(name => gzipSize(assets[name].source()))
		);

		// map of de-hashed filenames to their final size
		this.sizes = toMap(
			assetNames.map(filename => this.stripHash(filename)),
			sizes
		);

		// get a list of unique filenames
		const files = [
			...Object.keys(sizesBefore),
			...Object.keys(this.sizes)
		].filter(dedupe);

		const width = Math.max(...files.map(file => file.length));
		let output = '';
		const items = [];
		for (const name of files) {
			const size = this.sizes[name] || 0;
			const sizeBefore = sizesBefore[name] || 0;
			const delta = size - sizeBefore;
			const msg = new Array(width - name.length + 2).join(' ') + name + ' ⏤  ';
			const color =
				size > 100 * 1024
					? 'red'
					: size > 40 * 1024
						? 'yellow'
						: size > 20 * 1024
							? 'cyan'
							: 'green';
			let sizeText = chalk[color](prettyBytes(size));
			let deltaText = '';
			if (delta && Math.abs(delta) > 1) {
				deltaText = (delta > 0 ? '+' : '') + prettyBytes(delta);
				if (delta > 1024) {
					sizeText = chalk.bold(sizeText);
					deltaText = chalk.red(deltaText);
				}
				else if (delta < -10) {
					deltaText = chalk.green(deltaText);
				}
				sizeText += ` (${deltaText})`;
			}
			let text = msg + sizeText + '\n';
			const item = {
				name,
				sizeBefore,
				size,
				sizeText,
				delta,
				deltaText,
				msg,
				color
			};
			items.push(item);
			if (this.options.decorateItem) {
				text = this.options.decorateItem(text, item) || text;
			}
			output += text;
		}
		if (this.options.decorateAfter) {
			const opts = {
				sizes: items,
				raw: { sizesBefore, sizes: this.sizes },
				output
			};
			const text = this.options.decorateAfter(opts);
			if (text) {
				output += '\n' + text.replace(/^\n/g, '');
			}
		}
		await this.save(items);
		return output;
	}

	async getSizes(cwd) {
		const files = await glob(this.pattern, { cwd, ignore: this.exclude });

		const sizes = await Promise.all(
			files.map(file => gzipSize.file(path.join(cwd, file)).catch(() => null))
		);

		return toMap(files.map(filename => this.stripHash(filename)), sizes);
	}
}


/**
 * @name Item
 * @typedef Item
 * @property {string} name Filename of the item
 * @property {number} sizeBefore Previous size, in kilobytes
 * @property {number} size Current size, in kilobytes
 * @property {string} sizeText Formatted current size
 * @property {number} delta Difference from previous size, in kilobytes
 * @property {string} deltaText Formatted size delta
 * @property {string} msg Full item's default message
 * @property {string} color The item's default CLI color
 * @public
 */


/**
 * @name Data
 * @typedef Data
 * @property {Item[]} sizes List of file size items
 * @property {string} output Current buffered output
 * @public
 */

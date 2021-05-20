import { EventListener, NodeInterface, isNodeEntry } from '../types/node';
import { ActiveTrigger, CardEntry, CardType } from '../types/card';
import { ChangeInterface, ChangeOptions } from '../types/change';
import { EngineInterface } from '../types/engine';
import { RangeInterface } from '../types/range';
import Range from '../range';
import ChangeEvent from './event';
import Parser, { TextParser } from '../parser';
import { ANCHOR_SELECTOR, CURSOR_SELECTOR, FOCUS_SELECTOR } from '../constants';
import {
	combinTextNode,
	formatEngineValue,
	getDocument,
	getWindow,
} from '../utils';
import { Path } from 'sharedb';
import {
	CARD_ELEMENT_KEY,
	CARD_LEFT_SELECTOR,
	CARD_RIGHT_SELECTOR,
} from '../constants/card';
import {
	DATA_ELEMENT,
	EDITABLE,
	EDITABLE_SELECTOR,
	ROOT,
} from '../constants/root';
import Paste from './paste';
import { SelectionInterface } from '../types/selection';
import Selection from '../selection';

class ChangeModel implements ChangeInterface {
	private engine: EngineInterface;
	private options: ChangeOptions;
	private changeTimer: NodeJS.Timeout | null = null;
	event: ChangeEvent;
	valueCached: string | null = null;
	onChange: (value: string) => void;
	onSelect: () => void;
	onSetValue: () => void;
	rangePathBeforeCommand: Path[] | null = null;
	marks: Array<NodeInterface> = [];
	blocks: Array<NodeInterface> = [];
	inlines: Array<NodeInterface> = [];

	constructor(engine: EngineInterface, options: ChangeOptions = {}) {
		this.options = options;
		this.engine = engine;
		this.event = new ChangeEvent(engine, {});

		this.onChange = this.options.onChange || function() {};
		this.onSelect = this.options.onSelect || function() {};
		this.onSetValue = this.options.onSetValue || function() {};

		this.initNativeEvents();
	}

	private _change() {
		if (!this.isComposing()) {
			this.engine.card.gc();
			const value = this.getValue({
				ignoreCursor: true,
			});
			if (!this.valueCached || value !== this.valueCached) {
				this.onChange(value);
				this.valueCached = value;
			}
		}
	}

	change() {
		const range = this.getRange();
		const editableElement = range.startNode.closest(EDITABLE_SELECTOR);
		if (editableElement.length > 0) {
			const card = this.engine.card.find(editableElement, true);
			if (card?.onChange) card?.onChange(editableElement);
		}
		this.clearChangeTimer();
		this.changeTimer = setTimeout(() => {
			this._change();
		}, 200);
	}

	private clearChangeTimer() {
		if (this.changeTimer) clearTimeout(this.changeTimer);
	}

	getSelectionRange() {
		const { container } = this.engine;
		const { window } = container;
		let range = Range.from(this.engine, window!, false);
		if (!range) {
			range = Range.create(this.engine, window!.document)
				.select(container, true)
				.shrinkToElementNode()
				.collapse(false);
		}
		return range;
	}

	getRange() {
		return this.getSelectionRange();
	}

	select(range: RangeInterface) {
		const { container, mark, block, inline, node } = this.engine;
		const { window } = container;
		const selection = window?.getSelection();
		//折叠状态
		if (range.collapsed) {
			const { startNode, startOffset } = range;
			//如果节点下只要一个br标签，并且是<p><br /><cursor /></p>,那么选择让光标选择在 <p><cursor /><br /></p>
			if (
				((startNode.isElement() &&
					1 === startOffset &&
					1 === startNode.children().length) ||
					(2 === startOffset &&
						2 === startNode.children().length &&
						startNode.first()?.isCard())) &&
				'br' === startNode.last()?.name
			) {
				range.setStart(startNode, startOffset - 1);
				range.collapse(true);
			}
		}
		//修复inline光标
		const {
			startNode,
			endNode,
			startOffset,
			endOffset,
		} = range.cloneRange().shrinkToTextNode();
		const prev = startNode.prev();
		const next = endNode.next();
		//光标上一个节点是inline节点，让其选择在inline节点后的零宽字符后面
		if (
			prev &&
			!prev.isCard() &&
			!node.isVoid(prev) &&
			node.isInline(prev)
		) {
			const text = startNode.text();
			//前面是inline节点，后面是零宽字符
			if (/^\u200B/g.test(text) && startOffset === 0) {
				range.setStart(endNode, startOffset + 1);
				if (range.collapsed) range.collapse(true);
			}
		}
		//光标下一个节点是inline节点，让其选择在inline节点前面的零宽字符前面
		if (
			next &&
			!next.isCard() &&
			!node.isVoid(next) &&
			node.isInline(next)
		) {
			const text = endNode.text();
			if (/\u200B$/g.test(text) && endOffset === text.length) {
				range.setEnd(endNode, endOffset - 1);
				if (range.collapsed) range.collapse(false);
			}
		}
		//光标内侧位置
		const inlineNode = inline.closest(startNode);
		if (
			!inlineNode.isCard() &&
			node.isInline(inlineNode) &&
			!node.isVoid(inlineNode)
		) {
			//左侧
			if (
				startNode.isText() &&
				!startNode.prev() &&
				startNode.parent()?.equal(inlineNode) &&
				startOffset === 0
			) {
				range.setStart(startNode, startOffset + 1);
				if (range.collapsed) range.collapse(true);
			}
			//右侧
			if (
				endNode.isText() &&
				!endNode.next() &&
				endNode.parent()?.equal(inlineNode) &&
				endOffset === endNode.text().length
			) {
				range.setEnd(endNode, endOffset - 1);
				if (range.collapsed) range.collapse(false);
			}
		}
		//在非折叠，或者当前range对象和selection中的对象不一致的时候重新设置range
		if (
			selection &&
			(range.collapsed ||
				(selection.rangeCount > 0 &&
					!range.equal(selection.getRangeAt(0))))
		) {
			selection.removeAllRanges();
			selection.addRange(range.toRange());
		}
		this.marks = mark.findMarks(range);
		this.blocks = block.findBlocks(range);
		this.inlines = inline.findInlines(range);
		return this;
	}

	/**
	 * 聚焦编辑器
	 * @param toStart true:开始位置,false:结束位置，默认为之前操作位置
	 */
	focus(toStart?: boolean) {
		const range = this.getRange();
		if (toStart !== undefined) {
			range
				.select(this.engine.container, true)
				.shrinkToElementNode()
				.collapse(toStart);
		}
		this.select(range);
		this.engine.container.get<HTMLElement>()?.focus();
		return this;
	}

	blur() {
		this.engine.container.get<HTMLElement>()?.blur();
		return this;
	}

	isComposing() {
		return this.event.isComposing;
	}

	isSelecting() {
		return this.event.isSelecting;
	}

	setValue(value: string, onParse?: (node: Node) => void) {
		const range = this.getRange();
		if (value === '') {
			range.setStart(this.engine.container[0], 0);
			range.collapse(true);
			this.select(range);
		} else {
			const { schema, conversion } = this.engine;
			const parser = new Parser(value, this.engine, node => {
				node.allChildren().forEach(child => {
					this.engine.mark.removeEmptyMarks(node);
					if (this.engine.node.isInline(child)) {
						this.engine.inline.repairCursor(child);
					}
					if (onParse) {
						onParse(child);
					}
				});
			});
			const { container, history } = this.engine;
			container.html(
				parser.toValue(schema, conversion.getValue(), false, true),
			);
			container.allChildren().forEach(child => {
				if (this.engine.node.isInline(child)) {
					this.engine.inline.repairCursor(child);
				}
			});
			this.engine.block.generateDataIDForDescendant(
				container.get<Element>()!,
			);
			this.engine.card.render();
			const cursor = container.find(CURSOR_SELECTOR);
			const selection: SelectionInterface = new Selection(
				this.engine,
				range,
			);

			if (cursor.length > 0) {
				selection.anchor = cursor;
				selection.focus = cursor;
			}

			const anchor = container.find(ANCHOR_SELECTOR);
			const focus = container.find(FOCUS_SELECTOR);

			if (anchor.length > 0 && focus.length > 0) {
				selection.anchor = anchor;
				selection.focus = focus;
			}

			if (selection.anchor && selection.focus) {
				selection.move();
				this.select(range);
				this.onSelect();
			}
			this.onSetValue();
			if (history) {
				history.clear();
			}
		}
	}

	getOriginValue() {
		return new Parser(
			this.engine.container.clone(true),
			this.engine,
		).toValue(this.engine.schema);
	}

	getValue(
		options: {
			ignoreCursor?: boolean;
		} = {},
	) {
		let value;
		if (options.ignoreCursor || this.isComposing()) {
			value = this.getOriginValue();
		} else {
			const range = this.getRange();
			let selection;
			if (!range.inCard()) {
				selection = range.createSelection();
			}
			value = this.getOriginValue();
			selection?.move();
		}
		return formatEngineValue(value);
	}

	cacheRangeBeforeCommand() {
		this.rangePathBeforeCommand = this.getSelectionRange().toPath();
	}

	getRangePathBeforeCommand() {
		const rangePath = this.rangePathBeforeCommand;
		this.rangePathBeforeCommand = null;
		return rangePath;
	}

	isEmpty() {
		const { container, node } = this.engine;
		return node.isEmptyWithTrim(container);
	}

	private repairInput(event: InputEvent, range: RangeInterface) {
		const { commonAncestorNode } = range;
		const card = this.engine.card.find(commonAncestorNode);
		const { node, mark, change } = this.engine;
		if (
			card &&
			(card.constructor as CardEntry).cardType === CardType.INLINE
		) {
			if (card.isLeftCursor(commonAncestorNode)) {
				const cardLeft = commonAncestorNode.closest(CARD_LEFT_SELECTOR);
				let cardLeftText = cardLeft.text().replace(/\u200B/g, '');
				if (cardLeftText) {
					cardLeftText = escape(cardLeftText);
					range.setStartBefore(card.root);
					range.collapse(true);
					this.select(range);
					node.html(cardLeft, '&#8203;');
					node.insertText(cardLeftText);
				}
			} else if (card.isRightCursor(commonAncestorNode)) {
				const cardRight = commonAncestorNode.closest(
					CARD_RIGHT_SELECTOR,
				);
				let cardRightText = cardRight.text().replace(/\u200B/g, '');
				if (cardRightText) {
					cardRightText = escape(cardRightText);
					range.setEndAfter(card.root);
					range.collapse(false);
					this.select(range);
					node.html(cardRight, '&#8203;');
					node.insertText(cardRightText);
				}
			} else this.getSafeRange(range);
		}

		let { startNode, startOffset } = range.cloneRange().shrinkToTextNode();
		const parent = startNode.parent();
		//输入时删除mark标签内零宽字符。
		if (startNode.isText() && parent && node.isMark(parent)) {
			let textNode = startNode.get<Text>()!;
			let text = startNode.text();

			//mark 插件禁止跟随样式时，将输入字符设置到mark标签外
			//输入光标在mark节点末尾
			if (
				startOffset === text.length &&
				event.data &&
				event.inputType.indexOf('insert') === 0
			) {
				let markParent: NodeInterface | undefined = parent;
				let markTops: Array<NodeInterface> = [];

				//循环查找
				while (markParent && node.isMark(markParent)) {
					const markPlugin = mark.findPlugin(markParent);
					//插件禁止跟随
					if (markPlugin && !markPlugin.followStyle) {
						markTops.push(markParent);
					}
					markParent = markParent.parent();
					//如果还有位于下方的同级节点，并且父级节点也是mark节点，说明当前光标不在末尾了
					const markParentP = markParent?.parent();
					if (
						markParent?.next() &&
						markParentP &&
						node.isMark(markParentP)
					) {
						break;
					}
				}
				//查看下一个节点是否是紧紧挨着的相同样式如果有，那就继续跟随样式
				const startNext = startNode.next();
				markTops.forEach((markTop, index) => {
					//第一种：<em>abc<cursor /></em><em>123</em> 或者 <em>abc<cursor /></em><strong><em>123</em></strong> 继续跟随
					//第二种：<span><strong><em>abc<cursor /></em></strong><em>123</em><span> 或者 <strong><em>abc<cursor /></em></strong><strong><em>123</em></strong> 继续跟随
					//第三种: <span><strong>abc<cursor /><em>123</em></strong></span> 继续跟随

					//是开始节点所在的mark节点，如果开始节点后面有节点就继续跟随
					if (parent.equal(markTop) && startNext) {
						markTops.splice(index, 1);
						return;
					}
					let next = markTop.next();
					let curNode: NodeInterface | undefined = markTop;
					//循环找到下一个节点，如果没有下一级节点，从父级节点查找父级的下一级。如果有下一级节点，并且父节点
					while (!next && curNode) {
						//找到父节点
						const parent:
							| NodeInterface
							| undefined = curNode.parent();
						//如果父节点是块级节点，就不找了
						if (parent && node.isBlock(parent)) break;
						//找到父级节点的下一级
						next = parent?.next() || null;
						curNode = parent;
					}
					let first = next;
					while (first && !first.isText()) {
						if (
							node.isMark(first) &&
							mark.compare(first, markTop)
						) {
							markTops.splice(index, 1);
							break;
						}
						first = first.first();
					}
				});
				if (markTops.length > 0) {
					const lastText = textNode.splitText(
						text.length - event.data.length,
					);
					lastText.remove();
					if (node.isEmpty(parent)) parent.remove();
					mark.unwrap(markTops.map(mark => mark.clone()));
					node.insertText(
						text.substr(text.length - event.data.length),
					);
					mark.merge();
					range = change
						.getRange()
						.cloneRange()
						.shrinkToTextNode();
					startNode = range.startNode;
					startOffset = range.startOffset;
					textNode = startNode.get<Text>()!;
					text = startNode.text();
				}
			}
			//输入光标在mark节点开始位置
			else if (
				event.data &&
				startOffset === event.data.length &&
				event.inputType.indexOf('insert') === 0
			) {
				let markParent: NodeInterface | undefined = parent;
				let markTops: Array<NodeInterface> = [];

				//循环查找
				while (markParent && node.isMark(markParent)) {
					const markPlugin = mark.findPlugin(markParent);
					//插件禁止跟随
					if (markPlugin && !markPlugin.followStyle) {
						markTops.push(markParent);
					}
					markParent = markParent.parent();
					//如果还有位于下方的同级节点，并且父级节点也是mark节点，说明当前光标不在末尾了
					const markParentP = markParent?.parent();
					if (
						markParent?.prev() &&
						markParentP &&
						node.isMark(markParentP)
					) {
						break;
					}
				}
				//查看上一个节点是否是紧紧挨着的相同样式如果有，那就继续跟随样式
				const startPrev = startNode.prev();
				markTops.forEach((markTop, index) => {
					//第一种：<em>abc</em><em><cursor />123</em> 或者 <em>abc</em><strong><em><cursor />123</em></strong> 继续跟随
					//第二种：<span><strong><em>abc</em></strong><em><cursor />123</em><span> 或者 <strong><em>abc</em></strong><strong><em><cursor />123</em></strong> 继续跟随
					//第三种: <span><strong><em>123</em><cursor />abc</strong></span> 继续跟随

					//是开始节点所在的mark节点，如果开始节点后面有节点就继续跟随
					if (parent.equal(markTop) && startPrev) {
						markTops.splice(index, 1);
						return;
					}
					let prev = markTop.prev();
					let curNode: NodeInterface | undefined = markTop;
					//循环找到上一个节点，如果没有上一级节点，从父级节点查找父级的上一级。如果有上一级节点，并且父节点
					while (!prev && curNode) {
						//找到父节点
						const parent:
							| NodeInterface
							| undefined = curNode.parent();
						//如果父节点是块级节点，就不找了
						if (parent && node.isBlock(parent)) break;
						//找到父级节点的下一级
						prev = parent?.prev() || null;
						curNode = parent;
					}
					let last = prev;
					while (last && !last.isText()) {
						if (node.isMark(last) && mark.compare(last, markTop)) {
							markTops.splice(index, 1);
							break;
						}
						last = last.last();
					}
				});
				if (markTops.length > 0) {
					textNode.splitText(event.data.length);
					textNode.remove();
					if (node.isEmpty(parent)) parent.remove();
					mark.unwrap(markTops.map(mark => mark.clone()));
					node.insertText(event.data);
					mark.merge();
					range = change
						.getRange()
						.cloneRange()
						.shrinkToTextNode();
					startNode = range.startNode;
					startOffset = range.startOffset;
					textNode = startNode.get<Text>()!;
					text = startNode.text();
				}
			}
			//输入时删除mark标签内零宽字符。
			if (text.length > 0 && /^\u200B$/g.test(text.substr(0, 1))) {
				textNode.splitText(1);
				textNode.remove();
			}
		}
		//输入时删除mark标签外最后的零宽字符
		const prev = startNode.prev();
		if (startNode.isText() && prev && node.isMark(prev)) {
			const textNode = startNode.get<Text>()!;
			const text = startNode.text();
			if (text.length > 0 && /^\u200B$/g.test(text.substr(0, 1))) {
				textNode.splitText(1);
				textNode.remove();
			}
		}
	}
	/**
	 * 获取安全可控的光标对象
	 * @param range 默认当前光标
	 */
	getSafeRange(range: RangeInterface = this.getRange()) {
		// 如果不在编辑器内，聚焦到编辑器
		const { commonAncestorNode } = range;
		if (
			!commonAncestorNode.isEditable() &&
			!commonAncestorNode.inEditor()
		) {
			range
				.select(this.engine.container, true)
				.shrinkToElementNode()
				.collapse(false);
		}
		//卡片
		let rangeClone = range.cloneRange();
		rangeClone.collapse(true);
		this.focusCardRang(rangeClone);
		if (
			!range.startNode.equal(rangeClone.startNode) ||
			range.startOffset !== rangeClone.startOffset
		)
			range.setStart(rangeClone.startContainer, rangeClone.startOffset);

		rangeClone = range.cloneRange();
		rangeClone.collapse(false);
		this.focusCardRang(rangeClone);
		if (
			!range.endNode.equal(rangeClone.endNode) ||
			range.endOffset !== rangeClone.endOffset
		)
			range.setEnd(rangeClone.endContainer, rangeClone.endOffset);

		if (range.collapsed) {
			rangeClone = range.cloneRange();
			rangeClone.enlargeFromTextNode();

			const startNode = this.engine.$(rangeClone.startContainer);
			const startOffset = rangeClone.startOffset;

			if (this.engine.node.isInline(startNode) && startOffset === 0) {
				range.setStartBefore(startNode[0]);
			}
			if (
				this.engine.node.isInline(startNode) &&
				startOffset === startNode[0].childNodes.length
			) {
				range.setStartAfter(startNode[0]);
			}
			range.collapse(true);
		}
		return range;
	}

	private focusCardRang(range: RangeInterface) {
		const { startNode, startOffset } = range;
		const card = this.engine.card.find(startNode);
		if (card && !card.isEditable) {
			const cardCenter = card.getCenter().get();
			if (
				cardCenter &&
				(!startNode.isElement() ||
					startNode[0].parentNode !== card.root[0] ||
					startNode.attributes(CARD_ELEMENT_KEY))
			) {
				const comparePoint = () => {
					const doc_rang = Range.create(this.engine);
					doc_rang.select(cardCenter, true);
					return doc_rang.comparePoint(startNode, startOffset) < 0;
				};

				if ('inline' === (card.constructor as CardEntry).cardType) {
					range.select(card.root);
					range.collapse(comparePoint());
					return;
				}

				if (comparePoint()) {
					card.focusPrevBlock(range, true);
				} else {
					card.focusNextBlock(range, true);
				}
			}
		}
	}

	private initNativeEvents() {
		const { container, $, card, clipboard } = this.engine;

		this.event.onInput((event: InputEvent) => {
			const range = this.getRange();
			this.repairInput(event, range);
			this.select(range);
			this.onSelect();
			this.change();
		});

		this.event.onDocument('selectionchange', () => {
			const { window } = container;
			const selection = window?.getSelection();
			if (selection && selection.anchorNode) {
				const range = Range.from(this.engine, selection)!;
				card.each(card => {
					const center = card.getCenter();
					if (center && center.length > 0) {
						let isSelect = selection.containsNode(center[0]);
						if (
							!isSelect &&
							!range.collapsed &&
							selection.focusNode
						) {
							const focusCard = this.engine.card.find(
								selection.focusNode,
								true,
							);
							if (
								focusCard &&
								card.root.equal(focusCard.root) &&
								(!selection.anchorNode ||
									!focusCard.root.contains(
										selection.anchorNode,
									))
							) {
								isSelect = true;
							}
						}
						card.select(isSelect);
					}
				});
				const cardComponent = card.getSingleSelectedCard(range);
				if (cardComponent) {
					cardComponent.select(true);
				}
			} else {
				card.each(card => card.select(false));
			}
		});
		this.event.onSelect(() => {
			const range = this.getRange();
			if (range.collapsed && range.containsCard()) {
				this.getSafeRange(range);
			}
			this.select(range);
			card.activate(
				range.commonAncestorNode,
				ActiveTrigger.CUSTOM_SELECT,
			);
			this.onSelect();
		});

		this.event.onDocument('click', (e: MouseEvent) => {
			if (!e.target) return;
			const cardComponent = card.find($(e.target));
			if (cardComponent) {
				const cardEntry = cardComponent.constructor as CardEntry;
				if (cardEntry.cardType === CardType.INLINE) {
					card.activate(
						cardComponent.root,
						ActiveTrigger.CLICK,
						cardEntry.toolbarFollowMouse ? e : undefined,
					);
				}
				if (cardComponent.onFocus) {
					cardComponent.onFocus();
				}
			}
		});

		this.event.onDocument('mousedown', (e: MouseEvent) => {
			if (!e.target) return;
			const targetNode = $(e.target);
			const cardComponent = card.find(targetNode);
			if (
				cardComponent &&
				(cardComponent.constructor as CardEntry).cardType ===
					CardType.INLINE
			) {
				return;
			}
			// 点击元素已被移除
			if (targetNode.closest('body').length === 0) {
				return;
			}
			// 阅读模式节点
			if (targetNode.closest('.am-view').length > 0) {
				return;
			}
			// 工具栏、侧边栏、内嵌工具栏的点击
			let node: NodeInterface | undefined = targetNode;
			while (node) {
				const attrValue = node.attributes(DATA_ELEMENT);
				if (attrValue && [ROOT, EDITABLE].indexOf(attrValue) < 0) {
					return;
				}
				node = node.parent();
			}
			//如果当前target是卡片，但是光标不在卡片上，让其选中
			const { startNode } = this.getRange();
			if (cardComponent && !card.find(startNode, true)) {
				card.select(cardComponent);
			}
			card.activate(targetNode, ActiveTrigger.MOUSE_DOWN);
		});

		this.event.onDocument('copy', event => {
			clipboard.write(event);
		});

		this.event.onContainer('cut', event => {
			event.stopPropagation();
			clipboard.write(event, undefined, () => {
				clipboard.cut();
				this.change();
			});
		});

		this.event.onPaste(data => {
			const { html, text, files, isPasteText } = data;
			let source = '';
			if (files.length === 0) {
				// 纯文本粘贴
				if (isPasteText) {
					let value = '';
					if (text) value = text;
					else if (html)
						value = new Parser(html, this.engine).toText();
					source = new TextParser(value).toHTML();
				} else {
					// 富文本粘贴
					if (
						html &&
						html.indexOf('<meta name="source" content="aomao" />') >
							-1
					) {
						source = html;
					} else if (text && /^https?:\/\/\S+$/.test(text)) {
						const value = escape(text);
						source = `<a href="${value}" target="_blank">${value}</a>`;
					} else if (html) {
						source = html;
					} else if (text) {
						source = new TextParser(text).toHTML();
					}
				}
			}
			if (this.engine.trigger('paste:event', data, source) === false)
				return;
			if (files.length === 0) {
				const fragment = new Paste(source, this.engine).normalize();
				this.engine.trigger('paste:before', fragment);
				this.insertFragment(fragment, range => {
					this.engine.trigger('paste:insert', range);
					const selection = range.createSelection();
					this.engine.card.render();
					selection.move();
					range.scrollRangeIntoView();
				});
				this.engine.trigger('paste:after');
			}
		});

		const insertCardAble = (range?: RangeInterface) => {
			// 找不到目标位置
			// TODO: 临时解决，如果 drop Range 在Card里则不触发
			return !range || card.closest(range.commonAncestorContainer);
		};

		this.event.onDrop(({ event, range, card, files }) => {
			if (card) {
				event.preventDefault();
				if (insertCardAble(range)) return;
				const cardEntry = card.constructor as CardEntry;
				const cardName = cardEntry.cardName;
				const cardValue = card.getValue();
				this.engine.card.remove(card.root);
				this.select(range!);
				this.engine.card.insert(cardName, cardValue);
			}
			if (files.length > 0) {
				event.preventDefault();
				if (insertCardAble(range)) return;
				this.select(range!);
				this.engine.trigger('drop:files', files);
			}
		});
	}

	combinTextNode() {
		combinTextNode(this.engine.container);
	}

	/**
	 * 应用一个具有改变dom结构的操作
	 * @param range 光标
	 */
	apply(range?: RangeInterface) {
		this.combinTextNode();
		if (range) this.select(range);
		this.change();
	}

	/**
	 * 插入片段
	 * @param fragment 片段
	 * @param callback 插入后的回调函数
	 */
	insertFragment(
		fragment: DocumentFragment,
		callback: (range: RangeInterface) => void = () => {},
	) {
		const { block, list, card, $, schema } = this.engine;
		const range = this.getSafeRange();
		const firstBlock = block.closest(range.startNode);
		const lastBlock = block.closest(range.endNode);
		const onlyOne = lastBlock[0] === firstBlock[0];
		const isBlockLast = block.isLastOffset(range, 'end');
		const mergeTags = schema.getCanMergeTags();
		const allowInTags = schema.getAllowInTags();
		const mergeNode = firstBlock.closest(mergeTags.join(','));
		const isCollapsed = range.collapsed;
		const childNodes = fragment.childNodes;
		const firstNode = $(fragment.firstChild || []);
		if (!isCollapsed) {
			this.deleteContent(range, onlyOne || !isBlockLast);
		}
		if (!firstNode[0]) {
			this.apply(range);
			return;
		}
		if (!this.engine.node.isBlock(firstNode) && !firstNode.isCard()) {
			range.shrinkToElementNode().insertNode(fragment);
			this.apply(range.collapse(false));
			return;
		}
		range.deepCut();
		const startNode =
			range.startContainer.childNodes[range.startOffset - 1];
		const endNode = range.startContainer.childNodes[range.startOffset];

		if (mergeNode[0]) {
			childNodes.forEach(node => {
				if (mergeTags.indexOf($(node).name) < 0) {
					this.engine.node.wrap(
						$(node),
						this.engine.node.clone(mergeNode, false),
					);
				}
			});
		}
		if (childNodes.length !== 0) {
			const doc = getDocument(range.startContainer);
			let lastNode = $(childNodes[childNodes.length - 1]);
			if ('br' === lastNode.name) {
				lastNode.remove();
				lastNode = $(childNodes[childNodes.length - 1]);
			}
			const fragment = doc.createDocumentFragment();
			let node: NodeInterface | null = $(childNodes[0]);
			while (node && node.length > 0) {
				this.engine.node.removeSide(node);
				const next: NodeInterface | null = node.next();
				if (!next) {
					lastNode = node;
				}
				fragment.appendChild(node[0]);
				node = next;
			}
			range.insertNode(fragment);
			range.shrinkToElementNode().collapse(false);
			const component = card.find(range.startNode);
			if (component) component.focus(range, false);
		}

		const getFirstChild = (node: NodeInterface) => {
			let child = node.first();
			if (!child || !this.engine.node.isBlock(child)) return node;
			while (allowInTags.indexOf(child ? child.name : '') > -1) {
				child = child!.first();
			}
			return child;
		};

		const getLastChild = (node: NodeInterface) => {
			let child = node.last();
			if (!child || !this.engine.node.isBlock(child)) return node;
			while (allowInTags.indexOf(child ? child.name : '') > -1) {
				child = child!.last();
			}
			return child;
		};

		const isSameListChild = (
			_lastNode: NodeInterface,
			_firstNode: NodeInterface,
		) => {
			const isSameParent =
				_firstNode.parent()?.name === _lastNode.parent()?.name;
			return (
				('p' === _firstNode.name && isSameParent) ||
				(_lastNode.name === _firstNode.name &&
					isSameParent &&
					!(
						'li' === _lastNode.name &&
						!list.isSame(_lastNode.parent()!, _firstNode.parent()!)
					))
			);
		};

		const removeEmptyNode = (node: NodeInterface) => {
			while (!node.isEditable()) {
				const parent = node.parent();
				node.remove();
				if (!parent || !this.engine.node.isEmpty(parent)) break;
				node = parent;
			}
		};

		const clearList = (
			lastNode: NodeInterface,
			nextNode: NodeInterface,
		) => {
			if (lastNode.name === nextNode.name && 'p' === lastNode.name) {
				const attr = nextNode.attributes();
				if (attr['data-id']) delete attr['data-id'];
				lastNode.attributes(attr);
			}
			if (
				this.engine.node.isLikeEmpty(lastNode) &&
				!this.engine.node.isLikeEmpty(nextNode)
			) {
				lastNode.get<Element>()!.innerHTML = '';
			}
			if (
				this.engine.node.isCustomize(lastNode) ===
				this.engine.node.isCustomize(nextNode)
			)
				list.unwrapCustomize(nextNode);
		};

		if (startNode) {
			const _firstNode = getFirstChild($(startNode.nextSibling || []))!;
			const _lastNode = getLastChild($(startNode))!;
			if (isSameListChild(_lastNode, _firstNode)) {
				clearList(_lastNode, _firstNode);
				this.engine.node.merge(_lastNode, _firstNode, false);
				removeEmptyNode(_firstNode);
			} else {
				if (
					this.engine.node.isEmpty(_lastNode) ||
					list.isEmptyItem(_lastNode)
				) {
					removeEmptyNode(_lastNode);
				}
			}
		}

		if (endNode) {
			const prevNode = getLastChild($(endNode.previousSibling || []))!;
			const nextNode = getFirstChild($(endNode))!;
			range
				.select(prevNode, true)
				.shrinkToElementNode()
				.collapse(false);
			if (nextNode && this.engine.node.isEmpty(nextNode)) {
				removeEmptyNode(nextNode);
			} else if (isSameListChild(prevNode, nextNode)) {
				this.engine.node.merge(prevNode, nextNode, false);
				removeEmptyNode(nextNode);
			}
		}
		block.merge(range);
		list.merge(undefined, range);
		if (callback) callback(range);
		this.apply(range);
	}

	/**
	 * 删除内容
	 * @param range 光标，默认获取当前光标
	 * @param isDeepMerge 删除后是否合并
	 */
	deleteContent(range?: RangeInterface, isDeepMerge?: boolean) {
		const safeRange = range || this.getSafeRange();
		if (safeRange.collapsed) {
			return;
		}
		const { mark, node, $ } = this.engine;
		let cloneRange = safeRange.cloneRange();
		cloneRange.collapse(true);
		const activeMarks = mark.findMarks(cloneRange);
		safeRange.enlargeToElementNode();
		// 获取上面第一个 Block
		const block = this.engine.block.closest(safeRange.startNode);
		// 获取的 block 超出编辑范围
		if (!block.isEditable() && !block.inEditor()) {
			if (!range) this.apply(safeRange);
			return;
		}
		// 先删除范围内的所有内容
		safeRange.extractContents();
		safeRange.collapse(true);
		// 后续处理
		const { startNode, startOffset } = safeRange;
		// 只删除了文本，不做处理
		if (startNode.isText()) {
			if (!range) this.apply(safeRange);
			return;
		}

		const prevNode = startNode[0].childNodes[startOffset - 1];
		const nextNode = startNode[0].childNodes[startOffset];
		let isEmptyNode = startNode[0].childNodes.length === 0;
		if (!isEmptyNode) {
			const firstChild = startNode[0].firstChild!;
			if (
				startNode[0].childNodes.length === 1 &&
				firstChild.nodeType === getWindow().Node.ELEMENT_NODE &&
				node.isCustomize(startNode) &&
				startNode.first()?.isCard()
			)
				isEmptyNode = true;
		}
		if (isEmptyNode && node.isBlock(startNode)) {
			let html = node.getBatchAppendHTML(activeMarks, '<br />');
			if (startNode.isEditable()) {
				html = '<p>'.concat(html, '</p>');
			}
			startNode.append($(html));
			const br = startNode.find('br');
			const parent = br.parent();
			if (parent && node.isMark(parent)) {
				node.replace(br, $('\u200b', null));
			}
			safeRange
				.select(startNode, true)
				.shrinkToElementNode()
				.shrinkToTextNode();
			safeRange.collapse(false);
			if (!range) this.apply(safeRange);
			return;
		}
		//深度合并
		const deepMergeNode = (
			range: RangeInterface,
			prevNode: NodeInterface,
			nextNode: NodeInterface,
			marks: Array<NodeInterface>,
		) => {
			if (
				node.isBlock(prevNode) &&
				!node.isVoid(prevNode) &&
				!prevNode.isCard()
			) {
				range.select(prevNode, true);
				range.collapse(false);
				const selection = range.createSelection();
				this.engine.node.merge(prevNode, nextNode);
				selection.move();
				const prev = range.getPrevNode();
				const next = range.getNextNode();
				// 合并之后变成空 Block
				const { startNode } = range;
				if (!prev && !next && node.isBlock(startNode)) {
					startNode.append(
						$(this.engine.node.getBatchAppendHTML(marks, '<br />')),
					);
					range.select(startNode.find('br'), true);
					range.collapse(false);
				}

				if (prev && next && !prev.isCard() && !next.isCard()) {
					deepMergeNode(range, prev, next, marks);
				}
			}
		};
		if (
			prevNode &&
			nextNode &&
			node.isBlock(prevNode) &&
			node.isBlock(nextNode) &&
			isDeepMerge
		) {
			deepMergeNode(safeRange, $(prevNode), $(nextNode), activeMarks);
		}
		startNode.children().each(node => {
			const domNode = $(node);
			if (
				!this.engine.node.isVoid(domNode) &&
				domNode.isElement() &&
				'' === this.engine.node.html(domNode)
			)
				domNode.remove();
			//给inline节点添加零宽字符，用于光标选择
			if (this.engine.node.isInline(domNode)) {
				this.engine.inline.repairCursor(domNode);
			}
		});
		//修复inline节点光标选择在最后的零宽字符上时，将光标位置移到inline节点末尾
		cloneRange = safeRange.cloneRange().shrinkToTextNode();
		if (
			cloneRange.startNode.isText() &&
			/^\u200B/g.test(cloneRange.startNode.text()) &&
			cloneRange.startOffset === 0
		) {
			const prev = cloneRange.startNode.prev();
			if (prev && this.engine.node.isInline(prev)) {
				safeRange.select(prev, true);
				safeRange.collapse(false);
			}
		}

		if (!range) this.apply(safeRange);
	}

	/**
	 * 删除节点，删除后如果是空段落，自动添加 BR
	 * @param node 要删除的节点
	 */
	addBrAfterDelete(node: NodeInterface) {
		const range = this.getRange();
		const parent = node.parent();
		node.remove();
		if (parent && this.engine.node.isEmpty(parent)) {
			if (parent.isEditable()) {
				this.engine.node.html(parent, '<p><br /></p>');
				range
					.select(parent, true)
					.shrinkToElementNode()
					.collapse(false);
			} else {
				this.engine.node.html(parent, '<br />');
				range.select(parent, true).collapse(false);
			}
			this.select(range);
		}
	}

	/**
	 * 去除当前光标最接近的block节点或传入的节点外层包裹
	 * @param node 节点
	 */
	unwrapNode(node?: NodeInterface) {
		const { block } = this.engine;
		const range = this.getRange();
		node = node || block.closest(range.startNode);
		if (!node.inEditor()) {
			return;
		}

		const selection = range.createSelection();
		this.engine.node.unwrap(node);
		selection.move();
		this.select(range);
	}

	/**
	 * 删除当前光标最接近的block节点或传入的节点的前面一个节点后合并
	 * @param node 节点
	 */
	mergeAfterDeletePrevNode(node?: NodeInterface) {
		const { block, $ } = this.engine;
		const range = this.getRange();
		node = node || block.closest(range.startNode);
		// <p><br />foo</p>，先删除 BR
		if (node.children().length > 1 && node.first()?.name === 'br') {
			node.first()?.remove();
			return;
		}
		let prevBlock = node.prev();
		// 前面没有 DOM 节点
		if (!prevBlock) {
			if (node.parent()?.inEditor()) {
				this.unwrapNode(node);
			}
			return;
		}
		// 前面是Card
		if (prevBlock.isCard()) {
			if (
				(node.children().length === 1 && node.first()?.name === 'br') ||
				this.engine.node.isEmpty(node)
			) {
				node.remove();
			}
			const card = this.engine.card.find(prevBlock);
			if (card) {
				this.engine.card.focus(card);
				this.select(range);
				return;
			}
		}
		// 前面是 void 节点
		if (this.engine.node.isVoid(prevBlock)) {
			prevBlock.remove();
			return;
		}
		// 前面是空段落
		if (
			this.engine.node.isRootBlock(prevBlock) &&
			this.engine.node.isEmpty(prevBlock)
		) {
			prevBlock.remove();
			return;
		}

		// 前面是文本节点
		if (prevBlock.isText()) {
			const paragraph = $('<p />');
			prevBlock.before(paragraph);
			paragraph.append(prevBlock);
			prevBlock = paragraph;
		}
		if (['ol', 'ul'].indexOf(prevBlock.name) >= 0) {
			prevBlock = prevBlock.last();
		}
		// 只有一个 <br /> 时先删除
		if (node.children().length === 1 && node.first()?.name === 'br') {
			node.first()?.remove();
		} else if (
			prevBlock &&
			prevBlock.children().length === 1 &&
			prevBlock.first()?.name === 'br'
		) {
			prevBlock.first()?.remove();
		}

		if (!prevBlock || prevBlock.isText()) {
			this.unwrapNode(node);
		} else {
			const selection = range.createSelection();
			this.engine.node.merge(prevBlock, node);
			selection.move();
			this.select(range);
			this.engine.mark.merge();
			this.engine.list.merge();
		}
	}

	/**
	 * 焦点移动到当前光标最接近的block节点或传入的节点前一个 Block
	 * @param block 节点
	 * @param isRemoveEmptyBlock 如果前一个block为空是否删除，默认为否
	 */
	focusPrevBlock(block?: NodeInterface, isRemoveEmptyBlock: boolean = false) {
		const range = this.getRange();
		block = block || this.engine.block.closest(range.startNode);
		let prevBlock = block.prev();
		if (!prevBlock) {
			return;
		}
		// 前面是Card
		if (prevBlock.isCard()) {
			const card = this.engine.card.find(prevBlock);
			if (card) card.focus(range);
			return;
		}
		// 前面是列表
		if (['ol', 'ul'].indexOf(prevBlock.name) >= 0) {
			prevBlock = prevBlock.last();
		}

		if (!prevBlock) {
			return;
		}

		if (isRemoveEmptyBlock && this.engine.node.isEmptyWithTrim(prevBlock)) {
			prevBlock.remove();
			return;
		}

		range.select(prevBlock, true);
		range.collapse(false);
		this.select(range);
	}

	destroy() {
		this.event.destroy();
		this.clearChangeTimer();
	}
}

export default ChangeModel;
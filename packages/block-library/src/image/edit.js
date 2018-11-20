/**
 * External dependencies
 */
import classnames from 'classnames';
import {
	get,
	isEmpty,
	map,
	last,
	pick,
	compact,
	find,
} from 'lodash';

/**
 * WordPress dependencies
 */
import { getPath } from '@wordpress/url';
import { __, sprintf } from '@wordpress/i18n';
import { Component, Fragment } from '@wordpress/element';
import { getBlobByURL, revokeBlobURL, isBlobURL } from '@wordpress/blob';
import {
	Button,
	ButtonGroup,
	IconButton,
	PanelBody,
	ResizableBox,
	SelectControl,
	Spinner,
	TextControl,
	TextareaControl,
	Toolbar,
	withNotices,
	ToggleControl,
} from '@wordpress/components';
import { withSelect } from '@wordpress/data';
import {
	RichText,
	BlockControls,
	InspectorControls,
	MediaPlaceholder,
	MediaUpload,
	MediaUploadCheck,
	BlockAlignmentToolbar,
	mediaUpload,
} from '@wordpress/editor';
import { withViewportMatch } from '@wordpress/viewport';
import { compose } from '@wordpress/compose';

/**
 * Internal dependencies
 */
import { createUpgradedEmbedBlock } from '../embed/util';
import ImageSize from './image-size';

/**
 * Module constants
 */
const MIN_SIZE = 20;
const LINK_DESTINATION_NONE = 'none';
const LINK_DESTINATION_MEDIA = 'media';
const LINK_DESTINATION_ATTACHMENT = 'attachment';
const LINK_DESTINATION_CUSTOM = 'custom';
const NEW_TAB_REL = 'noreferrer noopener';
const ALLOWED_MEDIA_TYPES = [ 'image' ];

export const pickRelevantMediaFiles = ( image ) => {
	const imageProps = pick( image, [ 'alt', 'id', 'link', 'caption' ] );
	imageProps.url = get( image, [ 'sizes', 'large', 'url' ] ) || get( image, [ 'media_details', 'sizes', 'large', 'source_url' ] ) || image.url;
	return imageProps;
};

/**
 * Is the URL a temporary blob URL? A blob URL is one that is used temporarily
 * while the image is being uploaded and will not have an id yet allocated.
 *
 * @param {number=} id The id of the image.
 * @param {string=} url The url of the image.
 *
 * @return {boolean} Is the URL a Blob URL
 */
const isTemporaryImage = ( id, url ) => ! id && isBlobURL( url );

/**
 * Is the url for the image hosted externally. An externally hosted image has no id
 * and is not a blob url.
 *
 * @param {number=} id  The id of the image.
 * @param {string=} url The url of the image.
 *
 * @return {boolean} Is the url an externally hosted url?
 */
const isExternalImage = ( id, url ) => url && ! id && ! isBlobURL( url );

class ImageEdit extends Component {
	constructor( { attributes } ) {
		super( ...arguments );
		this.updateAlt = this.updateAlt.bind( this );
		this.updateAlignment = this.updateAlignment.bind( this );
		this.onFocusCaption = this.onFocusCaption.bind( this );
		this.onImageClick = this.onImageClick.bind( this );
		this.onSelectImage = this.onSelectImage.bind( this );
		this.onSelectURL = this.onSelectURL.bind( this );
		this.updateImageURL = this.updateImageURL.bind( this );
		this.updateWidth = this.updateWidth.bind( this );
		this.updateHeight = this.updateHeight.bind( this );
		this.resetWidthHeight = this.resetWidthHeight.bind( this );
		this.onSetCustomHref = this.onSetCustomHref.bind( this );
		this.onSetLinkClass = this.onSetLinkClass.bind( this );
		this.onSetLinkRel = this.onSetLinkRel.bind( this );
		this.onSetLinkDestination = this.onSetLinkDestination.bind( this );
		this.onSetNewTab = this.onSetNewTab.bind( this );
		this.getFilename = this.getFilename.bind( this );
		this.toggleIsEditing = this.toggleIsEditing.bind( this );
		this.onUploadError = this.onUploadError.bind( this );
		this.onImageError = this.onImageError.bind( this );

		this.state = {
			captionFocused: false,
			isEditing: ! attributes.url,
		};
	}

	componentDidMount() {
		const { attributes, setAttributes } = this.props;
		const { id, url = '' } = attributes;

		if ( isTemporaryImage( id, url ) ) {
			const file = getBlobByURL( url );

			if ( file ) {
				mediaUpload( {
					filesList: [ file ],
					onFileChange: ( [ image ] ) => {
						setAttributes( pickRelevantMediaFiles( image ) );
					},
					allowedTypes: ALLOWED_MEDIA_TYPES,
				} );
			}
		}
	}

	componentDidUpdate( prevProps ) {
		const { id: prevID, url: prevURL = '' } = prevProps.attributes;
		const { id, url = '', fileWidth } = this.props.attributes;
		const imageData = this.props.image;

		if ( isTemporaryImage( prevID, prevURL ) && ! isTemporaryImage( id, url ) ) {
			revokeBlobURL( url );
		}

		if ( ! this.props.isSelected && prevProps.isSelected && this.state.captionFocused ) {
			this.setState( {
				captionFocused: false,
			} );
		}

		if ( url && imageData && ! fileWidth ) {
			// Old post or just uploaded image. Attempt to update the image props.
			const sizeFull = get( imageData, [ 'media_details', 'sizes', 'full' ] );
			const sizeLarge = get( imageData, [ 'media_details', 'sizes', 'large' ] );

			if ( sizeFull && url === sizeFull.source_url ) {
				if ( sizeLarge && this.imageMatchesRatio( sizeFull.width, sizeFull.height, sizeLarge.width, sizeLarge.height ) ) {
					// If the full size image was used, and there's a large size that matches the ratio, replace full with large size.
					this.updateImageURL( sizeLarge.source_url, pick( sizeLarge, [ 'width', 'height' ] ) );
				} else {
					// Add image file dimensions.
					this.props.setAttributes( {
						fileWidth: get( sizeFull, [ 'actual_size', 'width' ] ) || sizeFull.width,
						fileHeight: get( sizeFull, [ 'actual_size', 'height' ] ) || sizeFull.height,
					} );
				}
			}
		}
	}

	onUploadError( message ) {
		const { noticeOperations } = this.props;
		noticeOperations.createErrorNotice( message );
		this.setState( {
			isEditing: true,
		} );
	}

	onSelectImage( media ) {
		if ( ! media || ! media.url ) {
			this.props.setAttributes( {
				url: undefined,
				alt: undefined,
				id: undefined,
				caption: undefined,
			} );
			return;
		}

		this.setState( {
			isEditing: false,
		} );

		let src = media.url;
		let img = {};
		let fileWidth;
		let fileHeight;

		if ( media.sizes ) {
			// The "full" size is already included in `sizes`.
			img = media.sizes.large || media.sizes.full;
			src = img.url;
			fileWidth = get( img, [ 'actual_size', 'width' ] ) || img.width;
			fileHeight = get( img, [ 'actual_size', 'height' ] ) || img.height;
		}

		const attr = pickRelevantMediaFiles( media );
		attr.url = src;

		this.props.setAttributes( {
			...attr,

			// Not used in the editor, passed to the front-end in block attributes.
			fileWidth,
			fileHeight,
			editWidth: this.props.contentWidth,
		} );
	}

	onSetLinkDestination( value ) {
		let href;

		if ( value === LINK_DESTINATION_NONE ) {
			href = undefined;
		} else if ( value === LINK_DESTINATION_MEDIA ) {
			href = ( this.props.image && this.props.image.source_url ) || this.props.attributes.url;
		} else if ( value === LINK_DESTINATION_ATTACHMENT ) {
			href = this.props.image && this.props.image.link;
		} else {
			href = this.props.attributes.href;
		}

		this.props.setAttributes( {
			linkDestination: value,
			href,
		} );
	}

	onSelectURL( newURL ) {
		const { url } = this.props.attributes;

		if ( newURL !== url ) {
			this.props.setAttributes( {
				url: newURL,
				id: undefined,
				fileWidth: undefined,
				fileHeight: undefined,
			} );
			this.resetWidthHeight();
		}

		this.setState( {
			isEditing: false,
		} );
	}

	onImageError( url ) {
		// Check if there's an embed block that handles this URL.
		const embedBlock = createUpgradedEmbedBlock(
			{ attributes: { url } }
		);
		if ( undefined !== embedBlock ) {
			this.props.onReplace( embedBlock );
		}
	}

	onSetCustomHref( value ) {
		this.props.setAttributes( { href: value } );
	}

	onSetLinkClass( value ) {
		this.props.setAttributes( { linkClass: value } );
	}

	onSetLinkRel( value ) {
		this.props.setAttributes( { rel: value } );
	}

	onSetNewTab( value ) {
		const { rel } = this.props.attributes;
		const linkTarget = value ? '_blank' : undefined;

		let updatedRel = rel;
		if ( linkTarget && ! rel ) {
			updatedRel = NEW_TAB_REL;
		} else if ( ! linkTarget && rel === NEW_TAB_REL ) {
			updatedRel = undefined;
		}

		this.props.setAttributes( {
			linkTarget,
			rel: updatedRel,
		} );
	}

	onFocusCaption() {
		if ( ! this.state.captionFocused ) {
			this.setState( {
				captionFocused: true,
			} );
		}
	}

	onImageClick() {
		if ( this.state.captionFocused ) {
			this.setState( {
				captionFocused: false,
			} );
		}
	}

	updateAlt( newAlt ) {
		this.props.setAttributes( { alt: newAlt } );
	}

	updateAlignment( nextAlign ) {
		if ( nextAlign === 'wide' || nextAlign === 'full' ) {
			// Reset all sizing attributes.
			this.resetWidthHeight();
		}

		this.props.setAttributes( { align: nextAlign } );
	}

	/**
	 * Sets the `url` attribute of the block to the provided value, optionally
	 * with an explicit dimensions. If `dimensions` are not provided, the
	 * equivalent image size values will be used instead, if known and exists.
	 *
	 * @param {string}  url        URL to assign as block attribute.
	 * @param {?Object} dimensions Optional object of width, height values.
	 */
	updateImageURL( url, dimensions ) {
		this.resetWidthHeight();
		let fileWidth;
		let fileHeight;

		if ( dimensions && dimensions.width && dimensions.height ) {
			fileWidth = dimensions.width;
			fileHeight = dimensions.height;
		} else {
			// Find the image data.
			const size = find( this.getImageSizeOptions(), { value: url } );
			if ( size ) {
				fileWidth = size.imageData.width;
				fileHeight = size.imageData.height;
			}
		}

		this.props.setAttributes( {
			url,
			fileWidth,
			fileHeight,
		} );
	}

	updateWidth( width, fileWidth, fileHeight, userSetDimensions ) {
		width = parseInt( width, 10 );

		// Reset the image size when the user deletes the value.
		if ( ! width || ! fileWidth || ! fileHeight ) {
			this.resetWidthHeight();
			return;
		}

		const height = Math.round( fileHeight * ( width / fileWidth ) );
		this.setWidthHeight( width, height, fileWidth, fileHeight, userSetDimensions );
	}

	updateHeight( height, fileWidth, fileHeight, userSetDimensions ) {
		height = parseInt( height, 10 );

		// Reset the image size when the user deletes the value.
		if ( ! height || ! fileWidth || ! fileHeight ) {
			this.resetWidthHeight();
			return;
		}

		const width = Math.round( fileWidth * ( height / fileHeight ) );
		this.setWidthHeight( width, height, fileWidth, fileHeight, userSetDimensions );
	}

	setWidthHeight( width, height, fileWidth, fileHeight, userSetDimensions ) {
		this.props.setAttributes( {
			width,
			height,
			fileWidth,
			fileHeight,
			userSetDimensions,
			editWidth: this.props.contentwidth,
		} );
	}

	resetWidthHeight( fileWidth, fileHeight ) {
		if ( fileWidth && fileHeight ) {
			this.props.setAttributes( {
				fileWidth,
				fileHeight,
			} );
		}

		this.props.setAttributes( {
			width: undefined,
			height: undefined,
			userSetDimensions: undefined,
			editWidth: this.props.contentwidth,
		} );
	}

	/**
	 * Helper function to test if aspect ratios for two images match.
	 *
	 * @param {number} fullWidth  Width of the image in pixels.
	 * @param {number} fullHeight Height of the image in pixels.
	 * @param {number} targetWidth  Width of the smaller image in pixels.
	 * @param {number} targetHeight Height of the smaller image in pixels.
	 * @return {boolean} True if aspect ratios match within 1px. False if not.
	 */
	imageMatchesRatio( fullWidth, fullHeight, targetWidth, targetHeight ) {
		if ( ! fullWidth || ! fullHeight || ! targetWidth || ! targetHeight ) {
			return false;
		}

		const { width, height } = this.constrainImageDimensions( fullWidth, fullHeight, targetWidth );

		// If the image dimensions are within 1px of the expected size, we consider it a match.
		return ( Math.abs( width - targetWidth ) <= 1 && Math.abs( height - targetHeight ) <= 1 );
	}

	/**
	 * Calculates the new dimensions for a down-sampled image.
	 *
	 * Note that this is nearly a direct port of the equivalent PHP function
	 * `wp_constrain_dimensions`, and any refactorings should be made in mind
	 * of cross-environment applicability.
	 *
	 * @param {number} fullWidth   Current width of the image.
	 * @param {number} fullHeight  Current height of the image.
	 * @param {number} targetWidth Max width in pixels to constrain to.
	 *
	 * @return {Object} Object of `width`, `height` values.
	 */
	constrainImageDimensions( fullWidth, fullHeight, targetWidth ) {
		const ratio = targetWidth / fullWidth;

		// Very small dimensions may result in 0, 1 should be the minimum.
		const height = Math.max( 1, Math.round( fullHeight * ratio ) );
		let width = Math.max( 1, Math.round( fullWidth * ratio ) );

		// Sometimes, due to rounding, we'll end up with a result like this: 465x700 in a 177x177 box is 117x176... a pixel short.
		if ( width === targetWidth - 1 ) {
			width = targetWidth; // Round it up
		}

		return {
			width: width,
			height: height,
		};
	}

	getFilename( url ) {
		const path = getPath( url );
		if ( path ) {
			return last( path.split( '/' ) );
		}
	}

	getLinkDestinationOptions() {
		return [
			{ value: LINK_DESTINATION_NONE, label: __( 'None' ) },
			{ value: LINK_DESTINATION_MEDIA, label: __( 'Media File' ) },
			{ value: LINK_DESTINATION_ATTACHMENT, label: __( 'Attachment Page' ) },
			{ value: LINK_DESTINATION_CUSTOM, label: __( 'Custom URL' ) },
		];
	}

	toggleIsEditing() {
		this.setState( {
			isEditing: ! this.state.isEditing,
		} );
	}

	getImageSizeOptions() {
		const { imageSizes, image } = this.props;
		return compact( map( imageSizes, ( { name, slug } ) => {
			const imageData = get( image, [ 'media_details', 'sizes', slug ] );
			if ( ! imageData || ! imageData.source_url ) {
				return null;
			}
			return {
				label: name,
				value: imageData.source_url,
				imageData: imageData,
			};
		} ) );
	}

	render() {
		const { isEditing } = this.state;
		const {
			attributes,
			setAttributes,
			isLargeViewport,
			isSelected,
			className,
			maxWidth,
			noticeUI,
			toggleSelection,
			isRTL,
			contentWidth,
		} = this.props;
		const {
			url,
			alt,
			caption,
			align,
			id,
			href,
			rel,
			linkClass,
			linkDestination,
			width,
			height,
			userSetDimensions,
			linkTarget,
		} = attributes;
		const isExternal = isExternalImage( id, url );
		const imageSizeOptions = this.getImageSizeOptions();

		let toolbarEditButton;
		if ( url ) {
			if ( isExternal ) {
				toolbarEditButton = (
					<Toolbar>
						<IconButton
							className="components-icon-button components-toolbar__control"
							label={ __( 'Edit image' ) }
							onClick={ this.toggleIsEditing }
							icon="edit"
						/>
					</Toolbar>
				);
			} else {
				toolbarEditButton = (
					<MediaUploadCheck>
						<Toolbar>
							<MediaUpload
								onSelect={ this.onSelectImage }
								allowedTypes={ ALLOWED_MEDIA_TYPES }
								value={ id }
								render={ ( { open } ) => (
									<IconButton
										className="components-toolbar__control"
										label={ __( 'Edit image' ) }
										icon="edit"
										onClick={ open }
									/>
								) }
							/>
						</Toolbar>
					</MediaUploadCheck>
				);
			}
		}

		const controls = (
			<BlockControls>
				<BlockAlignmentToolbar
					value={ align }
					onChange={ this.updateAlignment }
				/>
				{ toolbarEditButton }
			</BlockControls>
		);

		if ( isEditing ) {
			const src = isExternal ? url : undefined;
			return (
				<Fragment>
					{ controls }
					<MediaPlaceholder
						icon="format-image"
						className={ className }
						onSelect={ this.onSelectImage }
						onSelectURL={ this.onSelectURL }
						notices={ noticeUI }
						onError={ this.onUploadError }
						accept="image/*"
						allowedTypes={ ALLOWED_MEDIA_TYPES }
						value={ { id, src } }
					/>
				</Fragment>
			);
		}

		const classes = classnames( className, {
			'is-transient': isBlobURL( url ),
			'is-resized': !! width || !! height,
			'is-focused': isSelected,
		} );

		const isResizable = [ 'wide', 'full' ].indexOf( align ) === -1 && isLargeViewport;
		const isLinkURLInputDisabled = linkDestination !== LINK_DESTINATION_CUSTOM;

		const getInspectorControls = ( imageWidth, imageHeight ) => (
			<InspectorControls>
				<PanelBody title={ __( 'Image Settings' ) }>
					<TextareaControl
						label={ __( 'Alt Text (Alternative Text)' ) }
						value={ alt }
						onChange={ this.updateAlt }
						help={ __( 'Alternative text describes your image to people who can’t see it. Add a short description with its key details.' ) }
					/>
					{ ! isEmpty( imageSizeOptions ) && (
						<SelectControl
							label={ __( 'Image Size' ) }
							value={ url }
							options={ imageSizeOptions }
							onChange={ this.updateImageURL }
						/>
					) }
					{ isResizable && (
						<div className="block-library-image__dimensions">
							<p className="block-library-image__dimensions__row">
								{ __( 'Image Dimensions' ) }
							</p>
							<div className="block-library-image__dimensions__row">
								<TextControl
									type="number"
									className="block-library-image__dimensions__width"
									label={ __( 'Width' ) }
									value={ userSetDimensions ? width : '' }
									placeholder={ imageWidth }
									min={ 1 }
									onChange={ ( value ) => {
										this.updateWidth( value, imageWidth, imageHeight, true );
									} }
								/>
								<TextControl
									type="number"
									className="block-library-image__dimensions__height"
									label={ __( 'Height' ) }
									value={ userSetDimensions ? height : '' }
									placeholder={ imageHeight }
									min={ 1 }
									onChange={ ( value ) => {
										this.updateHeight( value, imageWidth, imageHeight, true );
									} }
								/>
							</div>
							<div className="block-library-image__dimensions__row">
								<ButtonGroup aria-label={ __( 'Image Size' ) }>
									{ [ 25, 50, 75, 100 ].map( ( percent ) => {
										// Percentage is relative to the block width.
										let scaledWidth = Math.round( contentWidth * ( percent / 100 ) );
										let isCurrent = false;

										if ( scaledWidth > imageWidth ) {
											scaledWidth = imageWidth;
											isCurrent = percent === 100 && ( ! width || width === scaledWidth );
										} else {
											isCurrent = ( width === scaledWidth ) || ( ! width && percent === 100 && imageWidth > contentWidth );
										}

										return (
											<Button
												key={ percent }
												isSmall
												isPrimary={ isCurrent }
												aria-pressed={ isCurrent }
												onClick={ () => this.updateWidth( scaledWidth, imageWidth, imageHeight ) }
											>
												{ percent }%
											</Button>
										);
									} ) }
								</ButtonGroup>
								<Button
									isSmall
									onClick={ () => this.resetWidthHeight( imageWidth, imageHeight ) }
								>
									{ __( 'Reset' ) }
								</Button>
							</div>
						</div>
					) }
				</PanelBody>
				<PanelBody title={ __( 'Link Settings' ) }>
					<SelectControl
						label={ __( 'Link To' ) }
						value={ linkDestination }
						options={ this.getLinkDestinationOptions() }
						onChange={ this.onSetLinkDestination }
					/>
					{ linkDestination !== LINK_DESTINATION_NONE && (
						<Fragment>
							<TextControl
								label={ __( 'Link URL' ) }
								value={ href || '' }
								onChange={ this.onSetCustomHref }
								placeholder={ ! isLinkURLInputDisabled ? 'https://' : undefined }
								disabled={ isLinkURLInputDisabled }
							/>
							<ToggleControl
								label={ __( 'Open in New Tab' ) }
								onChange={ this.onSetNewTab }
								checked={ linkTarget === '_blank' } />
							<TextControl
								label={ __( 'Link CSS Class' ) }
								value={ linkClass || '' }
								onChange={ this.onSetLinkClass }
							/>
							<TextControl
								label={ __( 'Link Rel' ) }
								value={ rel || '' }
								onChange={ this.onSetLinkRel }
							/>
						</Fragment>
					) }
				</PanelBody>
			</InspectorControls>
		);

		// Disable reason: Each block can be selected by clicking on it
		/* eslint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/onclick-has-role, jsx-a11y/click-events-have-key-events */
		return (
			<Fragment>
				{ controls }
				<figure className={ classes }>
					<ImageSize src={ url } dirtynessTrigger={ align }>
						{ ( sizes ) => {
							const {
								imageWidthWithinContainer,
								imageHeightWithinContainer,
								imageWidth,
								imageHeight,
							} = sizes;

							const filename = this.getFilename( url );
							let defaultedAlt;
							if ( alt ) {
								defaultedAlt = alt;
							} else if ( filename ) {
								defaultedAlt = sprintf( __( 'This image has an empty alt attribute; its file name is %s' ), filename );
							} else {
								defaultedAlt = __( 'This image has an empty alt attribute' );
							}

							const img = (
								// Disable reason: Image itself is not meant to be interactive, but
								// should direct focus to block.
								/* eslint-disable jsx-a11y/no-noninteractive-element-interactions */
								<Fragment>
									<img src={ url } alt={ defaultedAlt } onClick={ this.onImageClick } onError={ () => this.onImageError( url ) } />
									{ isBlobURL( url ) && <Spinner /> }
								</Fragment>
								/* eslint-enable jsx-a11y/no-noninteractive-element-interactions */
							);

							// Floating a resized image can produce inaccurate `imageWidthWithinContainer`.
							const ratio = imageWidth / imageHeight;
							let constrainedWidth;
							let constrainedHeight;

							if ( ( align === 'wide' || align === 'full' ) && imageWidthWithinContainer > contentWidth ) {
								// Do not limit the width.
								constrainedWidth = imageWidthWithinContainer;
								constrainedHeight = imageHeightWithinContainer;
							} else {
								constrainedWidth = width || imageWidth;
								constrainedWidth = constrainedWidth	> contentWidth ? contentWidth : constrainedWidth;
								constrainedHeight = Math.round( constrainedWidth / ratio ) || undefined;
							}

							if ( ! isResizable || ! imageWidthWithinContainer ) {
								return (
									<Fragment>
										{ getInspectorControls( imageWidth, imageHeight ) }
										<div style={ {
											width: constrainedWidth,
											height: constrainedHeight,
										} }>
											{ img }
										</div>
									</Fragment>
								);
							}

							const minWidth = imageWidth < imageHeight ? MIN_SIZE : MIN_SIZE * ratio;
							const minHeight = imageHeight < imageWidth ? MIN_SIZE : MIN_SIZE / ratio;

							// With the current implementation of ResizableBox, an image needs an explicit pixel value for the max-width.
							// In absence of being able to set the content-width, this max-width is currently dictated by the vanilla editor style.
							// The following variable adds a buffer to this vanilla style, so 3rd party themes have some wiggleroom.
							// This does, in most cases, allow you to scale the image beyond the width of the main column, though not infinitely.
							// @todo It would be good to revisit this once a content-width variable becomes available.
							const maxWidthBuffer = maxWidth * 2.5;

							let showRightHandle = false;
							let showLeftHandle = false;

							/* eslint-disable no-lonely-if */
							// See https://github.com/WordPress/gutenberg/issues/7584.
							if ( align === 'center' ) {
								// When the image is centered, show both handles.
								showRightHandle = true;
								showLeftHandle = true;
							} else if ( isRTL ) {
								// In RTL mode the image is on the right by default.
								// Show the right handle and hide the left handle only when it is aligned left.
								// Otherwise always show the left handle.
								if ( align === 'left' ) {
									showRightHandle = true;
								} else {
									showLeftHandle = true;
								}
							} else {
								// Show the left handle and hide the right handle only when the image is aligned right.
								// Otherwise always show the right handle.
								if ( align === 'right' ) {
									showLeftHandle = true;
								} else {
									showRightHandle = true;
								}
							}
							/* eslint-enable no-lonely-if */

							return (
								<Fragment>
									{ getInspectorControls( imageWidth, imageHeight ) }
									<ResizableBox
										size={
											( constrainedWidth && constrainedHeight ) ? {
												width: constrainedWidth,
												height: constrainedHeight,
											} : undefined
										}
										minWidth={ minWidth }
										maxWidth={ imageWidth || maxWidthBuffer }
										minHeight={ minHeight }
										maxHeight={ imageHeight || ( maxWidthBuffer / ratio ) }
										lockAspectRatio
										enable={ {
											top: false,
											right: showRightHandle,
											bottom: true,
											left: showLeftHandle,
										} }
										onResizeStart={ () => {
											toggleSelection( false );
										} }
										onResizeStop={ ( event, direction, elt, delta ) => {
											let newWidth = parseInt( constrainedWidth + delta.width, 10 );

											// Snap-to-border for the last pixel when resizing by dragging. Takes care of rounding of the last pixel.
											if ( Math.abs( constrainedWidth - newWidth ) < 2 ) {
												newWidth = constrainedWidth;
											}

											// Don't upscale.
											if ( newWidth > imageWidth ) {
												newWidth = imageWidth;
											}

											if ( newWidth >= contentWidth ) {
												// The image was resized to greater than the block width. Reset to 100% width and height (that will also highlight the 100% width button).
												this.resetWidthHeight( imageWidth, imageHeight );
											} else {
												this.updateWidth( newWidth, imageWidth, imageHeight );
											}

											toggleSelection( true );
										} }
									>
										{ img }
									</ResizableBox>
								</Fragment>
							);
						} }
					</ImageSize>
					{ ( ! RichText.isEmpty( caption ) || isSelected ) && (
						<RichText
							tagName="figcaption"
							placeholder={ __( 'Write caption…' ) }
							value={ caption }
							unstableOnFocus={ this.onFocusCaption }
							onChange={ ( value ) => setAttributes( { caption: value } ) }
							isSelected={ this.state.captionFocused }
							inlineToolbar
						/>
					) }
				</figure>
			</Fragment>
		);
		/* eslint-enable jsx-a11y/no-static-element-interactions, jsx-a11y/onclick-has-role, jsx-a11y/click-events-have-key-events */
	}
}

export default compose( [
	withSelect( ( select, props ) => {
		const { getMedia } = select( 'core' );
		const { getEditorSettings } = select( 'core/editor' );
		const { id } = props.attributes;
		const {
			maxWidth,
			isRTL,
			imageSizes,
			// Note: At the time of implementation, this value will never be
			// found in settings and always default to the hard-coded value.
			contentWidth = 580,
		} = getEditorSettings();

		return {
			image: id ? getMedia( id ) : null,
			maxWidth,
			isRTL,
			imageSizes,
			contentWidth,
		};
	} ),
	withViewportMatch( { isLargeViewport: 'medium' } ),
	withNotices,
] )( ImageEdit );
